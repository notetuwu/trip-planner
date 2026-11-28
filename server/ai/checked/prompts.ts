// The checked planner's prompts. One set of rules, in one order of priority, for every step and every model: short
// and without contradictions, because small local models follow a few clear rules better than many overlapping ones.
// The model is asked for what it can know (which places, when, how long, how to get there, what it costs); where a
// place is, is worked out in code from its name, and the drive between towns is drawn by the map, so neither is asked
// for. The data sections (stays, bookings, requests, saved places) come from prompt-sections.ts like the usual planner's.
import { tune } from "../../settings";
import type { Day, Place } from "../../../shared/types";
import { DAY_SIZE, DAY_TRIP_MINUTES, paceOf } from "../../../shared/planner";
import { bookingsSection, placeLines, requestsSection, trainsSection } from "../prompt-sections";
import { DETAIL, dayShapeLines } from "../prompt";
import type { NearbyPlace } from "../../trip/nearby";
import { placeMixOf, prefsLines } from "../../trip/prefs";
import type { Trip } from "../types";
import { type Frame, LONG_HOURS, TOO_LONG_HOURS, legHours, travelLoad } from "./frames";
import { short } from "./text";
import type { Issue } from "./validate";

const hm = (h: number) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };

/** The order things are decided in, for every step. */
export const PRIORITIES = `## How to decide (in this order; a lower rule never beats a higher one)
1. Fixed: the dates, where they sleep each night, travel between stays, bookings and their own requests. Never change these.
2. Feasible: every day can really be done as written: real driving times (given below), the time it takes to get from one stop to the next, opening hours, how long each visit takes, meals, check-out (about 10:00) and check-in (about 15:00).
3. Must-sees, then the other saved places.
4. Sensible routes: nearby places on the same day, in walking order, no backtracking across town.
5. A good experience: variety and an easy pace.
6. Budget: stay under the daily budget (a ceiling, not a target).
7. The places themselves: as "Choosing places" says.
When something lower doesn't fit, leave it out. A must-see that can't be done feasibly is never squeezed in: put it in "unused" (or the day's notes) with the honest reason.`;

/** What a day holds, by pace: the one definition (shared/planner.ts). */
export function sizeRules(trip: Trip) {
  const s = DAY_SIZE[paceOf(trip.pace)];
  return `## Size of a day
- Full day: about ${s.full[0]}-${s.full[1]} sights or activities, each a real place. A big one (a palace with its gardens, a national park, a long hike) can take 3-5 hours and counts as one. Meals, rides, check-in/out and the hotel don't count. Never add filler to reach a number, and never leave a full day empty.
- Travel day: the stops on the way listed for that day, check-in on arrival, and at most ${s.travel[1]} light thing${s.travel[1] === 1 ? "" : "s"} near where they arrive (fewer after a long drive).
- Day trips more than about ${DAY_TRIP_MINUTES} minutes from where they sleep go on full days only, never on travel days. Each full day of a stay is different from the others: a day trip (an island, a ferry) once per stay, the other days in the town itself or somewhere else; no place twice in the trip.`;
}

/** Which places to pick, as the travelers like them: the famous sights, hidden gems, or both. */
export function placeRules(trip: Trip) {
  const mix = placeMixOf(trip);
  const own = `the essential sights of each town, which you know (the ones most visitors would be sorry to miss: the main square, the castle or palace, the cathedral, the famous museum, the river front), under their usual names`;
  const lists = `the OpenStreetMap lists below: real places with hours, the well-known ones first and lesser-known ones after them`;
  return `## Choosing places
- First the travelers' saved places and what they asked to see (listed per town where it exists).
- Then ${mix === "popular" ? `${own}. The lists are for restaurants and for checking names and hours; a lesser-known place from them only when a day has room left.`
    : mix === "hidden" ? `lesser-known places and local favourites: the ones marked as such in ${lists}, and the quiet ones you know of. One famous sight a day at most, early or late when it's quiet; skip the crowded ones.`
    : `${own}, two or three a day, with one lesser-known place a day from ${lists} or from what you know locals like.`}
- A place belongs to the town it's listed under: never on a day in another town.${prefsLines(trip.prefs) ? `
${prefsLines(trip.prefs)}` : ""}`;
}

/** Facts: what may be stated and what may not. */
export function factRules(trip: Trip) {
  return `## Facts
- Driving times marked "routing service" are real: allow at least that long, plus about 15% for breaks and parking. Don't make up shorter ones.
- Never state ferry, train or bus departure times, parking availability or ticket availability unless they're given below; write "check the current timetable" instead and allow a buffer. An island trip by car means a car ferry with ports, queues and a return crossing: plan it that way or not at all.
- Opening times aren't last admission, and ticket sales, parking and park closing can all differ: state only what's given; otherwise say to check the opening hours.
- Only real places, under their real names: saved places and places from the lists exactly as listed; otherwise well-known places you're sure exist. Never invent a restaurant, café or sight, never give coordinates or addresses (places are located by name in code). Don't invent prices, schedules or events: null for anything you don't know (a cost of 0 only when it's free).
- Events and holidays only on dates when they're actually in that place.${trip.researchNotes ? "\n- The research findings are dated and checked: a line marked \"don't plan with it\" is outside their stay." : ""}`;
}

/** How each stop is written. */
export function itemRules(trip: Trip) {
  const t = tune();
  const named = !!trip.people?.length;
  const splits = Object.values(trip.mustSeeWho || {}).some((n) => n < trip.travelers) || trip.stays.some((s) => (s.dayTrips || []).some((d) => d.people && d.people < trip.travelers));
  return `## Each stop
- "time": when it starts, "HH:MM"; "durationMinutes": how long they stay (a ride: the whole journey). Stops in time order. The time it takes to get from one stop to the next lies in the gap between them: a stop 20 minutes' walk away starts at least 20 minutes after the one before it ends.
- "transport": how they get to this stop from the one before, mode and minutes ("Walk, 10 min"; "Metro M2 from Deák Ferenc tér, 12 min"; "Drive from Vienna, 1 h 05 min; park at the Burgplatz garage"). The map draws the way itself from this.
- Never a stop for getting somewhere by car, taxi or on foot: no "Hotel → Palace (car)", no "Vienna → Bratislava (car)", no "Walk to the fort". The drive into a town is the "transport" of the first stop in that town. Checking in (or leaving the bags) is the first stop after arriving in the town they sleep in.
- A "transfer" is a stop ONLY for a ride that isn't by car or on foot and that the route has to pass a point for: a ferry or boat, a train, a flight, a bus between towns, a mountain railway or cable car. Name it "<from> → <to> (<mode>)": "Split → Hvar (ferry)", "Vitznau → Rigi Kulm (cog railway)". A scenic ride that is the attraction itself (a boat tour round the lake) is an activity, not a transfer.
- "kind": sight, activity, meal, transfer or other (check-in, check-out, the hotel).
- Names: the place's name only ("Hofburg", "Konoba Fetivi"), exactly as in the lists when it's from them. Not what they do there ("Walk along the Danube": name the place, "Chain Bridge"), never just the name of the town they're going to ("Budapest" is not a stop; the first real stop there is), no coordinates, no addresses.
- Meals: lunch and dinner each day (breakfast as below), a real named place from the lists where possible, never the same restaurant twice in the trip; when you know no real place, "Lunch near <a named spot>" rather than an invented name.
- "cost": for the whole group of ${trip.travelers} in ${trip.currency}, null if you don't know it; "costPer": person or group. "booking": essential, recommended or optional for anything paid to get in (null for free places, meals and the hotel), with "bookAhead" for the first two.
- "description": ${DETAIL[t.detail]}
- "notes" on the day: closures, holidays, bookings to make, and anything you couldn't verify.
${dayShapeLines(trip)}${splits ? `
- Where only part of the group does something, ${named ? `give those stops "who" (their names); everyone's stops have none.` : `give those stops "group" ("Group A") and "people"; everyone's stops have none.`} Each part gets its own meals, and stops stay in time order.` : named ? `\n- The travelers are ${trip.people!.join(", ")}.` : ""}${t.language ? `\n- Write all text for the travelers in ${t.language}; place names stay as they're known locally, JSON keys in English.` : ""}`;
}

/** A frame as lines for a prompt: the fixed facts of the day. */
export function frameLine(f: Frame) {
  const head = `${f.date} (${f.weekday}) · ${f.kind === "full" ? "full day" : "travel day"} · ${f.sleep ? `sleep in ${short(f.sleep.city)}${f.sleep.hotel ? ` (${f.sleep.hotel})` : ""}` : "trip ends"}`;
  const legs = f.legs.map((l) => {
    const h = legHours(l);
    const route = l.segments.length && l.segments.every((s) => s.drive)
      ? l.segments.map((s) => `${short(s.from)} → ${short(s.to)} ${hm(s.drive!.hours)} (${s.drive!.km} km)`).join(", ")
      : l.direct ? `${hm(l.direct.hours)} (${l.direct.km} km) direct` : "driving time unknown";
    const stops = l.stops.length ? `; stops on the way (the travelers' must-sees): ${l.stops.map((s) => `${s.name}${s.alternative ? ` [could instead be a day trip from ${short(s.alternative.city)}, ${s.alternative.km} km]` : ""}`).join("; ")}` : "";
    return `\n   travel ${short(l.from)} → ${short(l.to)}${l.mode ? ` by ${l.mode}` : ""}: ${route}${h != null && l.segments.length ? ` = ${hm(h)} driving in all (routing service)` : l.direct ? " (routing service)" : ""}${stops}`;
  }).join("");
  const load = travelLoad(f);
  const warn = load && load.total > TOO_LONG_HOURS
    ? `\n   ⚠ Too long as asked: about ${hm(load.total)} with driving, stops, lunch and check-out/in. Keep what matters most and move a stop to a full day nearby (its day-trip option above) or to "unused", saying why in the notes.`
    : load && load.total > LONG_HOURS ? `\n   ⚠ A long day (about ${hm(load.total)} with driving, stops, lunch and check-out/in): start early and add nothing else.` : "";
  const trips = f.dayTrips.length ? `\n   day trips planned from here (one full day each): ${f.dayTrips.join("; ")}` : "";
  const hol = f.holidays.length ? `\n   public holiday: ${f.holidays.join("; ")}` : "";
  const light = f.daylight ? `\n   daylight: ${f.daylight}` : "";
  return `- ${head}${legs}${warn}${trips}${hol}${light}`;
}

const poi = (p: NearbyPlace) => `- ${p.name} (${[p.kind, ...p.extras, ...(p.hours ? [`hours ${p.hours}`] : [])].join("; ")})`;
/** The places found for what they asked to see, by their words ("a lighthouse: Faro di X (lighthouse); …"). */
function wishedLines(wished: NearbyPlace[] | undefined) {
  if (!wished?.length) return "";
  const by = new Map<string, NearbyPlace[]>();
  for (const p of wished) by.set(p.for || "", [...(by.get(p.for || "") || []), p]);
  return [...by].map(([what, ps]) => `- ${what}: ${ps.map((p) => `${p.name} (${p.kind}${p.hours ? `; hours ${p.hours}` : ""})`).join("; ")}`).join("\n");
}

export interface OutlineInput {
  trip: Trip; frames: Frame[];
  /** Candidate places per stay, already chosen (saved places near it first). */
  candidates: { city: string; saved: Place[]; sights: NearbyPlace[]; wished?: NearbyPlace[] }[];
  unplaced: Place[];
}

function about(trip: Trip) {
  const n = Number(trip.travelers) || 1;
  const budget = trip.budgetPer === "person" && n > 1 ? `${trip.dailyBudget} ${trip.currency} per person per day (${trip.dailyBudget * n} for the group)` : `${trip.dailyBudget} ${trip.currency} per day for the group`;
  return `Travelers: ${n}. Interests: ${trip.interests || "none given"}.${trip.wishes?.trim() ? ` What they want to see: ${trip.wishes.trim()}.` : ""} Budget: ${budget} for activities, food and local transport.`;
}

export function outlinePrompt({ trip, frames, candidates, unplaced }: OutlineInput) {
  const requests = [requestsSection(trip), bookingsSection(trip), trainsSection(trip)].filter(Boolean).join("\n\n");
  const lists = candidates.map((c) => [
    c.saved.length ? `### ${short(c.city)}: saved places\n${placeLines(trip, c.saved)}` : "",
    c.wished?.length ? `### ${short(c.city)}: what they asked to see, found nearby (OpenStreetMap)\n${wishedLines(c.wished)}` : "",
    c.sights.length ? `### ${short(c.city)}: real places nearby (OpenStreetMap; the well-known first, then lesser-known)\n${c.sights.map(poi).join("\n")}` : "",
  ].filter(Boolean).join("\n")).filter(Boolean).join("\n\n") + (unplaced.length ? `\n\n### Location not known\n${placeLines(trip, unplaced)}` : "");
  return `You are planning a trip in steps. This step only decides which day gets what: no times yet; each day is written in detail afterwards.

## The trip
${about(trip)}

## The days (fixed; worked out in code, driving times from a routing service)
${frames.map((f) => frameLine(f)).join("\n")}
${requests ? `\n${requests}\n` : ""}${trip.researchNotes ? `\n## Research findings (gathered online; trust these over your memory)\n${trip.researchNotes}\n` : ""}
## Places to choose from
Build the days from the travelers' saved places, grouped by area, and the essential sights of each town that you know; the lists below add what they asked for and real lesser-known places. [MUST SEE] places must be on a day (on travel days as the stops on the way listed there); never use [SKIP] places; hotels are accommodation, not stops.
${lists || "(no lists; choose the sights of each town you're sure of)"}

${PRIORITIES}

${placeRules(trip)}

${sizeRules(trip)}

${factRules(trip)}

## Answer
JSON only: one entry in "days" for every date above, in order, each with its "places" (exact names, in a sensible order; on travel days the stops on the way listed for the day, in driving order, then anything near where they arrive). Every full day has places. "unused": saved places left out with the honest reason (every must-see you couldn't fit feasibly). "events": festivals, events or seasonal things during the trip (only from the research or the holidays above, only on dates when they're there). "tips": 6-10 practical tips for this trip. "planningNotes": how you split the days, where the must-sees went, any conflict and what you left out (under 200 words).`;
}

export interface BatchInput {
  trip: Trip;
  frames: Frame[];
  /** The whole outline as lines (context). */
  outline: string;
  /** Per date: the outline's plan for it. */
  plans: Map<string, { title: string; theme: string; places: string[] }>;
  saved: Place[];
  sights: NearbyPlace[];
  food: NearbyPlace[];
  wished?: NearbyPlace[];
  /** Places and restaurants earlier days already use (the shared ledger). */
  used: string[];
  research: string;
  /** How the day before ended. */
  before?: string;
}

export function batchPrompt(b: BatchInput) {
  const { trip } = b;
  const requests = [requestsSection(trip), bookingsSection(trip), trainsSection(trip)].filter(Boolean).join("\n\n");
  const days = b.frames.map((f) => {
    const p = b.plans.get(f.date);
    return `${frameLine(f)}${p ? `\n   plan: ${p.title}${p.theme ? ` - ${p.theme}` : ""}${p.places.length ? `\n   places: ${p.places.join("; ")}` : ""}` : ""}`;
  }).join("\n");
  return `You are writing ${b.frames.length === 1 ? "one day" : `${b.frames.length} days`} of a trip plan in detail. The outline of the whole trip is fixed; write only these days.

## The trip
${about(trip)}

## The whole trip (outline; don't repeat places from other days)
${b.outline}
${requests ? `\n${requests}\n` : ""}
## Write these days
${days}
${b.before ? `\nThe day before ended at: ${b.before}.` : ""}${b.saved.length ? `\n\n## Saved places for these days\n${placeLines(trip, b.saved)}` : ""}${b.wished?.length ? `\n\n## What they asked to see, found near these days' towns (OpenStreetMap)\n${wishedLines(b.wished)}` : ""}${b.sights.length ? `\n\n## Real places near where they are (OpenStreetMap: exact names and hours; the well-known first, then lesser-known)\n${b.sights.map(poi).join("\n")}` : ""}${b.food.length ? `\n\n## Restaurants and cafés near where they sleep (OpenStreetMap)\n${b.food.map(poi).join("\n")}` : ""}${b.used.length ? `\n\n## Already used on other days (don't use again)\n${b.used.join("; ")}` : ""}${b.research ? `\n\n## Research findings for these days (trust these over your memory)\n${b.research}` : ""}

${PRIORITIES}

${placeRules(trip)}

${sizeRules(trip)}

${factRules(trip)}

${itemRules(trip)}

## Answer
JSON only: {"days": [...]} with exactly these dates: ${b.frames.map((f) => f.date).join(", ")}.`;
}

/** Send back only the broken days, with what's wrong, and keep everything else. */
export function repairPrompt(trip: Trip, frames: Frame[], days: Day[], issues: Issue[], used: string[], outline: string) {
  const byDate = new Map<string, Issue[]>();
  for (const x of issues) if (x.date) byDate.set(x.date, [...(byDate.get(x.date) || []), x]);
  const shown = days.map((d) => ({ ...d, items: d.items.map(({ lat, lng, fixed, where, ...x }) => x) }));
  return `You are fixing ${days.length === 1 ? "one day" : `${days.length} days`} of a trip plan. Checks in code found the problems listed below. Change only what's needed to fix them: every other stop, time, description and cost stays exactly as it is. Never change where they sleep, the travel between stays or anything booked, and never remove a must-see to make a check pass (if one can't fit feasibly, say so in the day's notes).

## The whole trip (outline; don't use places from other days)
${outline}

## The fixed facts of these days
${frames.map((f) => frameLine(f)).join("\n")}

## The days as planned now
${shown.map((d) => JSON.stringify(d)).join("\n")}

## Problems found
${[...byDate].map(([date, list]) => `${date}:\n${list.map((x) => `- ${x.item != null ? `[stop ${x.item + 1}] ` : ""}${x.message}`).join("\n")}`).join("\n")}
${used.length ? `\n## Already used on other days (don't use)\n${used.join("; ")}\n` : ""}
${PRIORITIES}

${factRules(trip)}

${itemRules(trip)}

## Answer
JSON only: {"days": [...]} with exactly these dates, each complete: ${days.map((d) => d.date).join(", ")}.`;
}
