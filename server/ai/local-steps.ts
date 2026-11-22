// Step-by-step planning for local models (Settings → Planning → Local models → "Step by step"). A local model does
// much better with several small, clear tasks than with one huge prompt, so the plan is made in steps, one after
// another (a single graphics card runs one request at a time anyway):
//   1. code: the saved places sorted per stay (near it or its day trips, must-sees first), so no step sees all of them
//   2. model: the outline - which day goes where and which places go on it (short JSON)
//   3. model + web: research for exactly those days and places
//   4. model: each day in detail, one at a time, with only that day's places, nearby food and findings
// The usual checks (map, opening hours, fixes) run afterwards as for any plan.
import type { Day, Itinerary, Place, RunResult } from "../../shared/types";
import { km } from "../../shared/route";
import { addDays, errMsg } from "../config";
import { localResearch } from "../research/research";
import { askModel } from "./ask";
import { parseModelId, serverName } from "./local-models";
import { addMissingMustSees, normalizeItinerary, parseJsonLoose } from "./output";
import { buildPrompt } from "./prompt";
import { holidayLines, placeLines, requestsSection, stayLines, withDay } from "./prompt-sections";
import type { OnEvent, Trip } from "./types";

/** How far from a stay (or one of its day trips) a saved place counts as belonging to it. */
const NEAR_KM = 60;
/** The most saved places per stay handed to the outline (must-sees always). */
const PER_STAY = 40;

interface Outline {
  destination?: string; localCurrency?: string; summary?: string; planningNotes?: string;
  tips?: string[]; holidaysAndEvents?: Itinerary["holidaysAndEvents"]; unused?: Itinerary["unused"];
  days: { date: string; city: string; title?: string; theme?: string; travel?: string; places?: string[]; groups?: { group: string; people?: number; where?: string; places?: string[] }[] }[];
}

const lc = (s: unknown) => String(s ?? "").toLowerCase();

/** Step 1 (no model): each stay's saved places - near the stay or one of its day trips, must-sees first, then the
 *  closest - plus the ones whose location isn't known (matched by name or address where possible). */
export function placesByStay(trip: Trip, places: Place[]) {
  const must = new Set(trip.mustSee || []), skip = new Set(trip.skip || []);
  const stays = trip.stays.map((s) => ({
    s, at: typeof s.lat === "number" && typeof s.lng === "number" ? { lat: s.lat, lng: s.lng } : null,
    words: [s.city, ...(s.dayTrips || []).map((t) => t.place)].map((w) => lc(w).split(",")[0].trim()).filter(Boolean),
  }));
  const groups = stays.map(() => [] as { p: Place; score: number }[]), unplaced: Place[] = [];
  for (const p of places) {
    if (skip.has(p.title)) continue;
    const route = trip.mustSeeRoute?.[p.title];
    let best = -1, dist = Infinity;
    if (typeof p.lat === "number" && typeof p.lng === "number") {
      stays.forEach((x, i) => {
        if (!x.at || !(Number(x.s.nights) > 0)) return;
        const d = km(x.at, { lat: p.lat!, lng: p.lng! });
        if (d < dist) { dist = d; best = i; }
      });
      if (dist > NEAR_KM && !must.has(p.title)) {
        // Far from every stay, but maybe at one of a stay's day trips ("…, Onomichi"): matched by name or address.
        const text = lc(`${p.title} ${p.address || ""}`);
        best = stays.findIndex((x) => x.words.slice(1).some((w) => text.includes(w)));
        dist = 30;
      }
    } else {
      const text = lc(`${p.title} ${p.address || ""} ${p.note || ""}`);
      best = stays.findIndex((x) => x.words.some((w) => text.includes(w)));
      dist = 30;
    }
    // A must-see on the way between two stays goes with the stay you arrive at (its travel day).
    if (route?.how === "way" || route?.onWay) {
      const to = stays.findIndex((x) => lc(x.s.city) === lc(route.leg?.to));
      if (to >= 0) best = to;
    }
    if (best < 0) { if (must.has(p.title) || !(typeof p.lat === "number")) unplaced.push(p); continue; }
    groups[best].push({ p, score: (must.has(p.title) ? 1000 : 0) + (p.note || p.comment ? 5 : 0) - dist });
  }
  return {
    perStay: groups.map((g) => g.sort((a, b) => b.score - a.score).filter((x, i) => i < PER_STAY || must.has(x.p.title)).map((x) => x.p)),
    unplaced: unplaced.filter((p, i) => must.has(p.title) || i < 30),
  };
}

/** A "## Heading" section of the full prompt, so the steps use the same rules as planning in one go. */
function section(prompt: string, heading: string) {
  const i = prompt.indexOf(heading);
  if (i < 0) return "";
  const j = prompt.indexOf("\n## ", i + heading.length);
  return prompt.slice(i, j < 0 ? undefined : j).trim();
}

const json = (text: string) => { try { return parseJsonLoose(text); } catch { return null; } };

export async function planInSteps(trip: Trip, places: Place[], onEvent: OnEvent, abort: AbortSignal): Promise<RunResult> {
  const t0 = Date.now();
  const { kind, base, model } = parseModelId(trip.model);
  let tokens = 0, thinking = "";
  const ask = async (label: string, prompt: string, info: string) => {
    onEvent({ type: "prompt", label, info, text: prompt });
    let start = tokens;
    return askModel(trip.model, prompt, (n) => { tokens = start + n; onEvent({ type: "tokens", count: tokens, estimated: false }); }, {
      signal: abort,
      onText: (_reply, thought) => { if (thought.length > thinking.length) thinking = thought; },
      onRetry: (msg) => { start = tokens; onEvent({ type: "status", text: msg }); },
    });
  };
  const full = buildPrompt(trip, places, { notes: "json", schema: true, compact: true });
  const dayRules = section(full, "## What every day must look like");
  const outputRules = section(full, "## Output rules");
  const travelers = Number(trip.travelers) || 1;
  const budget = trip.budgetPer === "person" && travelers > 1 ? `${trip.dailyBudget} ${trip.currency} per person per day (${trip.dailyBudget * travelers} for the group)` : `${trip.dailyBudget} ${trip.currency} per day`;
  const about = `Travelers: ${travelers}. Interests: ${trip.interests || "none given"}. Pace: ${trip.pace || "balanced"}. Budget: ${budget}, a ceiling, not a target.`;
  const requests = requestsSection(trip);

  // --- 1. The saved places per stay (code) ---
  onEvent({ type: "status", text: "Step 1 of 4: sorting your places by stay…" });
  const { perStay, unplaced } = placesByStay(trip, places);
  const candidates = trip.stays.map((s, i) => perStay[i].length ? `### ${s.city} (near the stay or its day trips)\n${placeLines(trip, perStay[i])}` : "").filter(Boolean).join("\n\n")
    + (unplaced.length ? `\n\n### Location not known\n${placeLines(trip, unplaced)}` : "");

  // --- 2. The outline ---
  onEvent({ type: "status", text: "Step 2 of 4: outlining the days…" });
  const routeRules = dayRules.split("\n").filter((l) => /day trip|split|daylight|travel day|chosen by the travelers|routing service/i.test(l)).join("\n");
  const outlinePrompt = `You are planning a trip in steps. This step is only the outline: which day goes where, its theme, and which places go on it. Times, transport and meals are written later, day by day.

## The trip
${about}

## Stays
${stayLines(trip)}
${requests ? `\n${requests}\n` : ""}${holidayLines(trip) ? `\n## Public holidays during the trip\n${holidayLines(trip)}\n` : ""}
## The travelers' saved places, by stay
Build the days primarily from these: they saved them because they want to go. Use as many as fit well, grouped by area into themed days. Places marked [MUST SEE] must be on a day; never use [SKIP] places. Hotels are accommodation, not stops.
${candidates || "(none; choose well-known sights yourself)"}

## Rules
- One entry for every calendar day from the first arrival to the final departure, in order, dates YYYY-MM-DD.
- About ${/relaxed/i.test(trip.pace || "") ? "2-3" : /packed/i.test(trip.pace || "") ? "5-7" : "3-5"} sights or activities per full day (don't list meals; they're added later). Arrival and departure days are lighter.
- Keep each day in one area; a day trip is one day in that town. Each place goes on one day only.
- Dates, bookings and skips in the travelers' requests decide where things go: put booked things on their booked day.
${routeRules}

## Answer
Only this JSON:
{"destination": "country", "localCurrency": "ISO code", "summary": "2-4 sentences", "planningNotes": "how you split the days, where the must-sees went, what you left out and why (under 200 words)",
 "tips": ["6-10 practical tips for this trip"], "holidaysAndEvents": [{"date": "YYYY-MM-DD", "name": "...", "impact": "what it means for the plan"}],
 "unused": [{"place": "saved place you left out", "reason": "short"}],
 "days": [{"date": "YYYY-MM-DD", "city": "town(s) of the day, e.g. Osaka / Kyoto", "title": "short title", "theme": "one sentence", "travel": "on travel days: e.g. Osaka → Hakone by train, else empty",
   "places": ["exact names of the places that day, in a sensible order"],
   "groups": [{"group": "Group A", "people": 2, "where": "town", "places": ["..."]}]}]}
"groups" only on split days (then "places" holds what everyone does together).`;
  let outline: Outline | null = null;
  for (let attempt = 0; attempt < 2 && !outline; attempt++) {
    const reply = await ask(attempt ? "Outline (asked again)" : "Step 2: the outline", attempt ? `${outlinePrompt}\n\nYour last answer wasn't usable JSON with a "days" list. Answer with the JSON only.` : outlinePrompt,
      `${model} (${serverName(kind, base)}) · the days, their themes and places`);
    const o = json(reply);
    if (o && Array.isArray(o.days) && o.days.length) outline = o as Outline;
  }
  if (!outline) throw new Error(`${model} didn't return a usable outline of the days. Try again, or plan "In one go" (Settings → Planning).`);
  outline.days = outline.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d.date))).sort((a, b) => a.date.localeCompare(b.date));
  if (outline.planningNotes) onEvent({ type: "notes", text: outline.planningNotes });
  const outlineLines = outline.days.map((d) => `- ${withDay(d.date)} ${d.city}: ${d.title || ""}${d.places?.length ? ` (${d.places.join("; ")})` : ""}${d.groups?.length ? ` · split: ${d.groups.map((g) => `${g.group} ${g.where || ""} (${(g.places || []).join("; ")})`).join(" / ")}` : ""}`).join("\n");

  // --- 3. Research for exactly these days ---
  let research: { notes: string; urls: string[] } | null = null;
  if (trip.research) {
    onEvent({ type: "status", text: "Step 3 of 4: researching the planned days online…" });
    const prompt = `You are researching a trip whose days are already outlined, before each day gets written in detail. Use the web_search and fetch_page tools to check, for these days and places:
- opening hours and closing days on the planned date (with its weekday), and current ticket prices; whether booking ahead is needed
- events, festivals or closures on those dates
- how to get there: trains or buses between the towns, travel times and fares

${about}

The outlined days:
${outlineLines}

Start with the must-sees and places with tickets or limited hours. Prefer official websites; say what you're after with looking_for. Don't repeat a search in other words. When you are done, reply with a concise summary as "- " bullet points, each naming the place and date it's about and ending with its source URL in brackets; also list briefly what you couldn't find out. Don't ask questions or offer to do more: nobody can answer.`;
    try {
      research = await localResearch({ kind, base, model, trip, places, onEvent, abort, prompt, onThinking: () => {}, tick: () => {} });
      if (research.notes) onEvent({ type: "notes", text: `**Research findings**\n\n${research.notes}` });
    } catch (e) {
      if (abort.aborted) throw e;
      onEvent({ type: "notes", text: `**No web research:** ${errMsg(e) === "NO_TOOLS" ? `${model} can't use tools` : errMsg(e).slice(0, 160)}.` });
    }
  }

  // --- 4. Each day in detail ---
  const byTitle = new Map(places.map((p) => [lc(p.title), p]));
  const findings = (research?.notes || "").split("\n").filter((l) => l.trim());
  const days: Day[] = [];
  for (let i = 0; i < outline.days.length; i++) {
    if (abort.aborted) throw new Error("Stopped");
    const o = outline.days[i];
    onEvent({ type: "status", text: `Step 4 of 4: writing day ${i + 1} of ${outline.days.length} (${o.city})…` });
    const names = [...(o.places || []), ...(o.groups || []).flatMap((g) => g.places || [])];
    const saved = names.map((n) => byTitle.get(lc(n))).filter((p): p is Place => !!p);
    const stay = trip.stays.filter((s) => s.start && o.date >= s.start && o.date <= addDays(s.start, Number(s.nights) || 0));
    const stayIdx = stay.map((s) => trip.stays.indexOf(s));
    const light = stayIdx.map((k) => trip.daylight?.[k]).find(Boolean);
    const towns = lc(`${o.city} ${o.groups?.map((g) => g.where).join(" ") || ""}`);
    const near = (trip.nearby || []).filter((n) => stay.some((s) => lc(s.city) === lc(n.city)) || towns.includes(lc(n.city).split(",")[0]));
    const food = near.flatMap((n) => n.food.slice(0, 12).map((p) => `- ${p.name} (${[p.kind, ...p.extras, ...(p.hours ? [`hours ${p.hours}`] : [])].join("; ")}) {location ${p.lat},${p.lng}}`)).slice(0, 18);
    const keys = [...names, ...o.city.split(/[\/,→]/)].map((n) => lc(n).replace(/\(.*$/, "").trim()).filter((n) => n.length > 3);
    const relevant = findings.filter((l) => keys.some((k) => lc(l).includes(k))).join("\n").slice(0, 3000);
    const holidays = (trip.holidays || []).filter((h) => h.date === o.date).map((h) => `${h.name} (public holiday)`).join(", ");
    const prev = days.at(-1)?.items.at(-1);
    const dayPrompt = `You are writing one day of a trip plan in detail. The outline of the whole trip is fixed; write only this day.

## The trip
${about}
Where they sleep: ${stay.map((s) => `${s.city}${s.hotel ? ` (at/near ${s.hotel})` : ""}`).join(", then ") || "see the outline"}.${light ? `\nDaylight there: ${light}.` : ""}
${prev ? `The day before ended at: ${prev.place}.` : ""}

## The whole trip (don't repeat places from other days)
${outlineLines}
${requests ? `\n${requests}\n` : ""}

## This day: ${withDay(o.date)}, ${o.city}
Title: ${o.title || ""}${o.theme ? `\nTheme: ${o.theme}` : ""}${o.travel ? `\nTravel today: ${o.travel}` : ""}${holidays ? `\nHoliday: ${holidays}` : ""}
Places for this day (use them all, in a sensible order${o.groups?.length ? "; everyone together" : ""}): ${(o.places || []).join("; ") || "(none: choose fitting sights near the day's town)"}
${(o.groups || []).map((g) => `${g.group} (${g.people || "?"} people${g.where ? `, in ${g.where}` : ""}): ${(g.places || []).join("; ")}`).join("\n")}
${saved.length ? `\nWhat the travelers saved about them:\n${placeLines(trip, saved)}` : ""}
${food.length ? `\n## Real restaurants and cafés near where they sleep (from OpenStreetMap; exact names and locations)\n${food.join("\n")}` : ""}
${relevant ? `\n## Research findings for this day (trust these over your own memory)\n${relevant}` : ""}

${dayRules}

${outputRules}
- This overrides the rule about one entry per calendar day: return the itinerary with "days" containing only this one day, dated ${o.date}.${o.groups?.length ? `\n- This is a split day: every item of a group gets that "group" and its "people"; items everyone does together have no group.` : ""}

## Answer
Only this JSON: {"days": [{"date": "${o.date}", "city": "${o.city.replace(/"/g, "'")}", "title": "...", "estimatedCost": 0, "notes": "...", "items": [{"time": "HH:MM", "place": "...", "description": "...", "cost": 0, "transport": "...", "lat": 0, "lng": 0, "kind": "sight"}]}]}`;
    let day: Day | null = null;
    for (let attempt = 0; attempt < 2 && !day; attempt++) {
      try {
        const reply = await ask(`Step 4: day ${i + 1} (${o.date})${attempt ? ", asked again" : ""}`, attempt ? `${dayPrompt}\n\nYour last answer wasn't usable. Answer with the JSON only.` : dayPrompt, `${model} · day ${i + 1} of ${outline.days.length}`);
        const it = normalizeItinerary(json(reply), travelers);
        const d = it?.days.find((x) => x.date === o.date) || it?.days[0];
        if (d && d.items.length) day = { ...d, date: o.date };
      } catch (e) { if (abort.aborted) throw e; }
    }
    // A day that still won't come out keeps the outline's places, so the plan isn't lost; Re-plan can redo it.
    days.push(day || { date: o.date, city: o.city, title: o.title || o.city, estimatedCost: 0, notes: "This day couldn't be written in detail; use Re-plan on it.",
      items: names.map((n) => ({ time: "", place: n, description: "", cost: 0 })) } as Day);
    onEvent({ type: "progress", days: days.length });
  }

  const itinerary = normalizeItinerary({
    destination: outline.destination, localCurrency: outline.localCurrency, summary: outline.summary, tips: outline.tips,
    holidaysAndEvents: outline.holidaysAndEvents, unused: outline.unused, days,
  }, travelers)!;
  addMissingMustSees(itinerary, trip.mustSee || []);
  let reasoning = `${outline.planningNotes || ""}\n\n*Planned step by step: an outline of the days, then ${research ? "research for them, then " : ""}each day on its own.*`.trim();
  if (research?.notes) {
    reasoning += `\n\n**Research findings**\n\n${research.notes}`;
    itinerary.sources = [...new Set([...research.urls, ...(research.notes.match(/https?:\/\/[^\s)\]]+/g) || [])])];
  }
  return {
    itinerary, reasoning, thinking: thinking.slice(0, 20000), durationMs: Date.now() - t0, tokens,
    engine: `${model} (${serverName(kind, base)}, step by step)`, billing: "local",
  };
}
