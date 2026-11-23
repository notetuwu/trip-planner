// The trip chat: questions about the trip on screen ("what's on Thursday?", "where can we eat near the castle?", "is
// two nights in Salzburg enough?"), answered by the selected model from what the page sends about the trip (stays,
// the itinerary, must-sees, the ideas notes) and the conversation so far. Plain text back, streamed as it's written.
// Asked to change the plan ("swap days 3 and 4", "a vegan lunch on day 2"), it says what it will change and hands
// back the change for the page to offer: re-planning the day concerned, or the whole plan.
// Nothing from here goes into plan generation: the chat is its own request, with its own prompt.
import { type AskImage, askModel } from "../ai/ask";
import { geocodeOne } from "../geo/geocode";
import type { Report } from "../util/progress-stream";
import { type Town, parseLookups, runLookups, withoutLookups } from "./chat-lookups";

export interface CompanionTurn { role: "me" | "ai"; text: string }
export interface CompanionRequest {
  model: string;
  question: string;
  context?: string;
  history?: CompanionTurn[];
  today?: string;
  /** How many days the itinerary has (0: none yet, so no changes to offer). */
  days?: number;
  /** A summary of the conversation before `history` (long chats are compacted). */
  summary?: string;
  /** Pictures the traveler attached to this message (base64, without the "data:" prefix). */
  images?: AskImage[];
  /** Where the stays are, for lookups ("12 km from Vaduz"). */
  towns?: Town[];
}
/** A change to the plan the traveler asked for: the days it touches (1-based; empty = all over the plan) and the
 *  instruction for the planner. */
export interface PlanChange { days: number[]; request: string; trip?: TripOps; stops?: StopOp[] }
/** A small edit the page makes itself, without re-planning: add a stop at a free time, remove one, or move one's time. */
export interface StopOp {
  op: "add" | "remove" | "time";
  /** 1-based day number. */
  day: number;
  place: string;
  time?: string;
  description?: string;
  /** Where it is ("Gafleistrasse, Triesenberg, Liechtenstein"): looked up for its exact spot. */
  where?: string;
  cost?: number;
  kind?: string;
  lat?: number;
  lng?: number;
}
/** Changes to the trip's setup (not the day-by-day plan): how must-sees are fitted in, and the stays' day trips. */
export interface TripOps {
  /** Visit on a travel day between stays (this also takes them off the stays' day trips). */
  onTheWay?: string[];
  /** Visit from where they sleep. */
  fromStay?: string[];
  removeDayTrips?: { stay: string; place: string }[];
  addDayTrips?: { stay: string; place: string; mode: string }[];
  /** New places for their places (e.g. one recognised in a picture): name, where it is, and whether it's a must-see. */
  addPlaces?: { name: string; where: string; must: boolean }[];
}

const MAX_CONTEXT = 60_000, MAX_TURN = 4_000, MAX_ROUNDS = 2;
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export function companionPrompt(req: CompanionRequest) {
  const history = (Array.isArray(req.history) ? req.history : []).slice(-60)
    .map((t) => `${t.role === "me" ? "Traveler" : "You"}: ${clip(t.text, MAX_TURN)}`).join("\n\n");
  const days = Number(req.days) || 0;
  const changes = days ? `
## Changing the plan
The travelers can change their ${days}-day itinerary through you. When their message asks for a change to it (or says yes to a change you suggested), write one or two sentences on what will change, then end your reply with one last line exactly like this:
CHANGE: {"days": [3], "request": "the precise instruction for the planner, in English, with every detail agreed in the conversation"}
"days" lists the day numbers the change touches (several when it moves things between days, [] when it changes the whole trip).
Small edits don't need the planner: adding a stop at a time that's free, removing a stop, or moving a stop to another time. Write those as "stops" instead of "request" (and "days": []); the page makes them straight away, without re-planning the day:
CHANGE: {"days": [], "request": "", "stops": [{"op": "add", "day": 5, "time": "14:30", "place": "Aussichtsturm Gaflei", "where": "Gafleistrasse, Triesenberg, Liechtenstein", "description": "what it is and why go, how to get there, how long to allow", "cost": 0, "kind": "sight"}]}
Other ops: {"op": "remove", "day": 5, "place": "the stop's name exactly as in the plan"} and {"op": "time", "day": 5, "place": "the stop's name exactly as in the plan", "time": "08:00"} (e.g. breakfast moved to when the café opens). For an added stop, "where" is its address or "place, town, country" (it's looked up on the map, so it must be the real location). Use "request" instead when other stops would have to move or the day needs rearranging.
Add "trip" only when the trip's setup changes too (the day-by-day plan is made from it), with just the parts that change, for example: "trip": {"onTheWay": ["Burg Hohenwerfen"]}. Its parts:
- "onTheWay": places to visit on a travel day between two stays instead of as a day trip (this also takes them off the stays' day trips). Use it whenever they want a place "on the way".
- "fromStay": places to visit from where they sleep.
- "removeDayTrips": [{"stay": "town of the stay", "place": "place"}] and "addDayTrips": [{"stay": "town of the stay", "place": "place", "mode": "car|train|bus|walk|bike|ferry"}] for the day trips listed under the stays.
- "addPlaces": [{"name": "the place's real name", "where": "town, country", "must": true}] adds places to their places (for example one you recognised in a picture they sent), as a must-see when they want to go for sure.
Day trips listed under the stays above stay in the trip until removed here, even if a day's plan changes, so when a place moves from a day trip to somewhere else, remove that day trip too. When only the setup changes and the days are already right, use "days": [] and "request": "".
Only add the CHANGE line when they asked for a change, not for questions or for ideas they haven't asked for; if what they want is unclear, ask instead. Never offer a change for a place you couldn't identify: if you don't know what or where a place is (and a lookup didn't settle it), say so and ask them (for its address, or a link), and offer the change once you know. Always answer in words first: the CHANGE line is never the whole reply.
` : `
## Changing the trip before there's a plan
There's no day-by-day itinerary yet, but you can change the trip's setup, which the plan will be made from: add places to their must-sees (a place they want to see, or one you recognised in a picture), say whether a must-see is visited on the way between stays or from a stay, and add or remove the stays' day trips. When they ask for that (or say yes to it), write one or two sentences on what will change, then end your reply with one last line exactly like this:
CHANGE: {"days": [], "request": "", "trip": {"addPlaces": [{"name": "the place's real name", "where": "town, country", "must": true}]}}
"trip" can have:
- "addPlaces": [{"name": "…", "where": "town, country", "must": true}] adds places to their places, as must-sees when they want to go for sure ("must": false for an idea).
- "onTheWay": ["place"] visits a must-see on a travel day between two stays; "fromStay": ["place"] from where they sleep.
- "removeDayTrips": [{"stay": "town of the stay", "place": "place"}] and "addDayTrips": [{"stay": "town of the stay", "place": "place", "mode": "car|train|bus|walk|bike|ferry"}].
Use the place's real name and where it is (look it up first if you aren't sure). For anything about the days themselves (what's on which day), tell them to generate the itinerary first. Only add the CHANGE line when they asked for a change; always answer in words first.
`;
  return `You are the travel companion for the trip below: a friendly, well-travelled local expert the travelers can ask anything about their trip, before or during it.

## The trip
${clip(req.context, MAX_CONTEXT) || "(Nothing planned yet: no stays or itinerary.)"}

## Looking things up
When you aren't sure about a place (what it is, where it is, how far it is, whether it's open, how to get there), look it up instead of guessing. To do that, reply with nothing but lookup lines; you'll get the results and be asked again (up to ${MAX_ROUNDS} rounds, at most 3 lines each):
LOOKUP: place | Gaflei, Liechtenstein
LOOKUP: route | Vaduz | Gaflei, Triesenberg
LOOKUP: search | Aussichtsturm Gaflei opening hours
"place" finds where a place is on OpenStreetMap (address, coordinates, how far from the trip's towns); "route" gives the driving distance and time between two places; "search" searches the web. Don't look up what the trip above already says.

## How to answer
- Answer from the trip above when the question is about it (dates, days, stops, stays, costs, bookings, their ideas notes). Say which day or stay you mean.
- Only state what you know or looked up. If you're unsure, say so plainly in the answer (not only in your thinking) and ask rather than describe a place confidently.
- For anything else (food, getting around, what's worth it, weather, customs, packing, alternatives) use what you know about the places; say when something is worth checking (opening hours, prices and timetables change).
- Be concrete and brief: a few sentences or a short list. Suggest a change to the plan when it helps.
- Plain text with light Markdown only (**bold**, "- " bullets). No tables.
- Answer in the language the traveler writes in.${req.today ? `\n- Today is ${clip(req.today, 20)}.` : ""}
${changes}${req.summary ? `\n## Earlier in this conversation (summary)\n${clip(req.summary, 8_000)}\n` : ""}${history ? `\n## The conversation so far\n${history}\n` : ""}
## The traveler says
${clip(req.question, MAX_TURN)}${req.images?.length ? `

They attached ${req.images.length} picture${req.images.length > 1 ? "s" : ""}. Work out what ${req.images.length > 1 ? "they show" : "it shows"}: the place's name and where it is, as precisely as you can, and say how sure you are (and what gives it away). If you can't tell (or aren't sure), say what you see and what would help, and mention they can click the picture and use "Search with Google" to look it up by image, then tell you the name. If they want it in the trip, add it with "addPlaces" (and change the days too if they ask).` : ""}`;
}

/** Strips what some models wrap answers in (a code fence, a leading "You:") and the CHANGE line (also half-written). */
export const cleanAnswer = (text: string) =>
  withoutLookups(text.trim()).replace(/^```(?:\w+)?\n([\s\S]*?)\n```$/, "$1").replace(/^(You|Assistant|Companion):\s*/i, "")
    .replace(/\n?[ \t`*]*CHANGE:[\s\S]*$/, "").replace(/\n[ \t]*C(H(A(N(G(E)?)?)?)?)?$/, "")
    // A change written without "CHANGE:" (the JSON on its own, at the end or as the whole reply) isn't text to show.
    .replace(/(^|\n)[ \t`]*(json)?\s*\{\s*"(days|request|trip)"[\s\S]*\}[ \t`]*$/, "").trim();

/** The change at the end of a reply, if there's a valid one. */
export function parseChange(text: string, days = 0): PlanChange | null {
  const m = text.match(/CHANGE:\s*(\{[\s\S]*\})/) || text.match(/(?:^|\n)[ \t`]*(?:json)?\s*(\{\s*"(?:days|request|trip)"[\s\S]*\})[ \t`]*$/);
  if (!m) return null;
  try {
    const c = JSON.parse(m[1]);
    const request = String(c.request || "").trim().slice(0, 2000);
    const trip = tripOps(c.trip);
    const stops = stopOps(c.stops, days);
    if (!request && !trip && !stops) return null;
    const list = (Array.isArray(c.days) ? c.days : []).map(Number).filter((d: number) => Number.isInteger(d) && d >= 1 && (!days || d <= days));
    return { days: request ? [...new Set<number>(list)].sort((a, b) => a - b) : [], request, ...(trip ? { trip } : {}), ...(stops ? { stops } : {}) };
  } catch { return null; }
}

/** Only well-formed stop edits (a known op, a day in the plan, a name; a time as HH:MM); null when there are none. */
export function stopOps(v: unknown, days = 0): StopOp[] | null {
  if (!Array.isArray(v)) return null;
  const str = (x: unknown, n: number) => (typeof x === "string" ? x.trim().slice(0, n) : "");
  const ops = v.slice(0, 10).map((x: any): StopOp | null => {
    const op = ["add", "remove", "time"].includes(x?.op) ? x.op : null, day = Number(x?.day), place = str(x?.place, 140);
    const time = /^\d{1,2}:\d{2}$/.test(str(x?.time, 5)) ? str(x.time, 5).padStart(5, "0") : "";
    if (!op || !place || !Number.isInteger(day) || day < 1 || (days && day > days) || (op !== "remove" && !time)) return null;
    return { op, day, place, ...(time ? { time } : {}),
      ...(op === "add" ? { description: str(x.description, 1200), where: str(x.where, 200), cost: Math.max(0, Number(x.cost) || 0), kind: ["sight", "activity", "meal", "other"].includes(x.kind) ? x.kind : "sight" } : {}) };
  }).filter((x): x is StopOp => !!x);
  return ops.length ? ops : null;
}

/** Added stops get their real spot from their address (not the model's idea of the coordinates). */
async function locateStops(stops: StopOp[]) {
  for (const s of stops.filter((x) => x.op === "add")) {
    const hit = await geocodeOne(s.where || s.place).catch(() => null) || (s.where ? await geocodeOne(s.place).catch(() => null) : null);
    if (hit) { s.lat = hit.lat; s.lng = hit.lng; }
  }
}

/** At most 4 pictures of the usual kinds, each up to about 6 MB. */
export function cleanImages(images: unknown): AskImage[] {
  if (!Array.isArray(images)) return [];
  return images.filter((i: any) => i && /^image\/(jpeg|png|webp|gif)$/.test(i.type) && typeof i.data === "string" && i.data.length < 8_000_000 && /^[A-Za-z0-9+/=]+$/.test(i.data.slice(0, 200)))
    .slice(0, 4).map((i: any) => ({ type: i.type, data: i.data }));
}

/** Only well-formed setup changes (names as short strings, known travel modes); null when there are none. */
export function tripOps(t: any): TripOps | null {
  if (!t || typeof t !== "object") return null;
  const name = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 120) : "");
  const names = (v: unknown) => (Array.isArray(v) ? v.map(name).filter(Boolean).slice(0, 20) : []);
  const MODES = ["car", "train", "bus", "walk", "bike", "ferry", "flight"];
  const ops: TripOps = {
    onTheWay: names(t.onTheWay), fromStay: names(t.fromStay),
    removeDayTrips: (Array.isArray(t.removeDayTrips) ? t.removeDayTrips : []).map((x: any) => ({ stay: name(x?.stay), place: name(x?.place) })).filter((x: any) => x.place).slice(0, 20),
    addDayTrips: (Array.isArray(t.addDayTrips) ? t.addDayTrips : []).map((x: any) => ({ stay: name(x?.stay), place: name(x?.place), mode: MODES.includes(x?.mode) ? x.mode : "car" })).filter((x: any) => x.place && x.stay).slice(0, 20),
    addPlaces: (Array.isArray(t.addPlaces) ? t.addPlaces : []).map((x: any) => ({ name: name(x?.name), where: name(x?.where), must: x?.must !== false })).filter((x: any) => x.name).slice(0, 10),
  };
  for (const k of Object.keys(ops) as (keyof TripOps)[]) if (!ops[k]!.length) delete ops[k];
  return Object.keys(ops).length ? ops : null;
}

/** Compacting a long chat: the earlier turns (and the summary before them) into a short summary to carry on from. */
export function compactPrompt(turns: CompanionTurn[], summary = "") {
  const text = turns.map((t) => `${t.role === "me" ? "Traveler" : "Companion"}: ${clip(t.text, MAX_TURN)}`).join("\n\n");
  return `Below is the start of a conversation between travelers and their travel companion about their trip${summary ? ", after a summary of what came before it" : ""}. Summarize it so the conversation can carry on without it: what they asked and decided, their preferences and worries, which changes to the plan were applied, undone or not applied, and anything still open. Short "- " bullets, at most about 15, with the specific names, days and numbers. Only the summary, no introduction.
${summary ? `\n## Summary of what came before\n${clip(summary, 8_000)}\n` : ""}
## The conversation
${text}`;
}

export async function compactChat(req: { model: string; turns?: CompanionTurn[]; summary?: string }, report: Report, signal?: AbortSignal) {
  const turns = (Array.isArray(req.turns) ? req.turns : []).slice(-200);
  if (!turns.length) return { summary: req.summary || "" };
  report({ type: "status", text: "Summarizing the earlier conversation…" });
  const summary = cleanAnswer(await askModel(req.model, compactPrompt(turns, req.summary), (n) => report({ type: "tokens", n }), {
    signal, nudge: "Write the summary right away.",
  }));
  if (!summary) throw new Error("The model didn't write a summary.");
  return { summary: summary.slice(0, 8_000) };
}

export async function askCompanion(req: CompanionRequest, report: Report, signal?: AbortSignal) {
  report({ type: "status", text: "Thinking…" });
  // How long it thought: from the first thought to the first word of the answer.
  let thinking = "", earlier = "", thinkFrom = 0, thinkTo = 0;
  const images = cleanImages(req.images);
  const towns = (Array.isArray(req.towns) ? req.towns : []).filter((t) => t?.name && Number.isFinite(t.lat) && Number.isFinite(t.lng)).slice(0, 30);
  const looked: string[] = [];
  let prompt = companionPrompt({ ...req, images }), answer = "";
  // Up to MAX_ROUNDS of lookups: the model asks, gets the results, and is asked again.
  for (let round = 0; ; round++) {
    const last = round >= MAX_ROUNDS;
    answer = await askModel(req.model, last && looked.length ? `${prompt}\n\nNo more lookups now: answer with what you have.` : prompt, (n) => report({ type: "tokens", n }), {
      signal, text: true, images,
      nudge: "Answer the traveler right away, briefly.",
      // The answer so far goes out as it's written (as "reasoning", the channel the page already shows live).
      onText: (reply, thought) => {
        const all = earlier + thought;
        if (thought && all !== thinking) { thinking = all; thinkFrom ||= Date.now(); report({ type: "thinking", text: all }); }
        const shown = cleanAnswer(reply);
        if (shown) { if (thinkFrom && !thinkTo) thinkTo = Date.now(); report({ type: "reasoning", text: shown }); }
        else if (thought) report({ type: "status", text: "Thinking…" });
      },
      onRetry: (message) => report({ type: "status", text: message }),
    });
    const lookups = last ? [] : parseLookups(answer);
    if (!lookups.length) break;
    const results = await runLookups(lookups, towns, (text) => report({ type: "status", text }));
    looked.push(...lookups.map((l) => `${l.kind}: ${l.args.join(" | ")}`));
    earlier = `${thinking}${thinking ? "\n\n" : ""}Looked up: ${lookups.map((l) => l.args.join(" → ")).join("; ")}\n\n`;
    thinking = earlier;
    report({ type: "thinking", text: thinking });
    prompt += `\n\n## Lookup results (round ${round + 1})\n${results}\n\nNow answer the traveler using these results${round + 1 < MAX_ROUNDS ? " (or look up something else, if you still need to)" : ""}.`;
  }
  const text = cleanAnswer(answer);
  // Without a plan, only setup changes count (must-sees, day trips): nothing on the days to change yet.
  const parsed = parseChange(answer, req.days || 0);
  const change = req.days ? parsed : parsed?.trip ? { days: [], request: "", trip: parsed.trip } : null;
  if (change?.stops) { report({ type: "status", text: "Finding the new stops on the map…" }); await locateStops(change.stops); }
  if (!text && !change) throw new Error("The model didn't answer properly (no text, only an empty change). Try again, or pick a different model in the chat's menu.");
  const thought = thinking.trim() ? { thinking: thinking.trim().slice(-20_000), thoughtSecs: Math.max(1, Math.round(((thinkTo || Date.now()) - thinkFrom) / 1000)) } : {};
  return { answer: text || "I'll change that.", ...(change ? { change } : {}), ...(looked.length ? { lookups: looked } : {}), ...thought };
}
