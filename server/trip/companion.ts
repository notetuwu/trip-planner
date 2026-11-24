// The trip chat: questions about the trip on screen ("what's on Thursday?", "where can we eat near the castle?", "is
// two nights in Salzburg enough?"), answered by the selected model from what the page sends about the trip (stays,
// the itinerary, must-sees, the ideas notes) and the conversation so far. Plain text back, streamed as it's written.
// Asked to change the plan ("swap days 3 and 4", "a vegan lunch on day 2"), it says what it will change and hands
// back the change for the page to offer: re-planning the day concerned, or the whole plan.
// Nothing from here goes into plan generation: the chat is its own request, with its own prompt.
import { type AskImage, askModel } from "../ai/ask";
import { geocodeOne } from "../geo/geocode";
import type { Report } from "../util/progress-stream";
import { type Source, type Town, parseLookups, runLookups, withoutLookups } from "./chat-lookups";

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
  /** Where they sleep each day (1-based day → lat, lng): stops the chat adds are looked up around there first. */
  dayAt?: Record<string, [number, number]>;
  /** What the page knows beyond the trip text, looked up on demand ("LOOKUP: trip | costs"): topic → text. */
  data?: Record<string, string>;
  /** The chat's mode: "ask" answers only (no changes offered); "manual" and "auto" may offer changes. */
  mode?: "ask" | "manual" | "auto";
}
/** A change to the plan the traveler asked for: the days it touches (1-based; empty = all over the plan) and the
 *  instruction for the planner. */
export interface PlanChange { days: number[]; request: string; trip?: TripOps; stops?: StopOp[]; edits?: EditOp[]; title?: string }
/** Anything else the travelers can change by hand, made straight away by the page (see EDITS_DOC in the prompt). */
export interface EditOp { op: string; [k: string]: string | number | boolean | undefined }
const EDIT_OPS: Record<string, string[]> = {
  set: ["field", "value"], stayNights: ["stay", "nights"], stayHotel: ["stay", "value"], stayTravel: ["stay", "value"], addStay: ["city", "after", "nights"], removeStay: ["stay"],
  moveStop: ["day", "place", "toDay", "time"], swapDays: ["day", "toDay"], setCost: ["day", "place", "value"], addBooking: ["name", "date", "from", "to"], removeBooking: ["name"],
  booked: ["item", "day", "place", "done"], packed: ["item", "done"], packAdd: ["value"], packRemove: ["value"], must: ["place"], skip: ["place"], setCar: ["fuel", "per100"], note: ["value"], idea: ["value"],
};
const SET_FIELDS = ["travelers", "dailyBudget", "currency", "pace", "fitness", "dayStart", "breakfast", "interests", "wishes"];
/** Edits that only make sense with a day-by-day plan. */
export const PLAN_EDITS = ["moveStop", "swapDays", "setCost", "booked"];

/** Only well-formed edits: a known op with its fields (strings short, numbers finite), a known field for "set". */
export function editOps(v: unknown, days = 0): EditOp[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.slice(0, 20).map((x: any): EditOp | null => {
    const keys = EDIT_OPS[x?.op];
    if (!keys) return null;
    const e: EditOp = { op: x.op };
    for (const k of keys) {
      const val = x[k];
      if (typeof val === "number" && Number.isFinite(val)) e[k] = val;
      else if (typeof val === "boolean") e[k] = val;
      else if (typeof val === "string") e[k] = val.trim().slice(0, k === "value" ? 600 : 140);
    }
    if (e.op === "set" && !SET_FIELDS.includes(String(e.field))) return null;
    for (const k of ["day", "toDay"]) if (e[k] != null && (!Number.isInteger(Number(e[k])) || Number(e[k]) < 1 || (days && Number(e[k]) > days))) return null;
    return e;
  }).filter((x): x is EditOp => !!x);
  return out.length ? out : null;
}
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
  /** Places that stop being must-sees (they stay in their places as ideas). */
  removeMust?: string[];
  /** The plan's costs worked out again for another number of travelers, without re-planning. */
  rescaleCosts?: { from: number; to: number; days?: number[]; after?: string };
}

const MAX_CONTEXT = 60_000, MAX_TURN = 4_000, MAX_ROUNDS = 2;
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export function companionPrompt(req: CompanionRequest) {
  const history = (Array.isArray(req.history) ? req.history : []).slice(-60)
    .map((t) => `${t.role === "me" ? "Traveler" : "You"}: ${clip(t.text, MAX_TURN)}`).join("\n\n");
  const days = Number(req.days) || 0;
  const topics = Object.keys(req.data || {});
  const changes = req.mode === "ask" ? `
## Answer only
The chat is in Ask mode: answer and look things up, but never offer a change (no CHANGE line). If they ask for one, say what you would change and that they can switch the chat to Manual or Auto mode (the mode button by the message box, or Shift+Tab) to make it.
` : days ? `
## Changing the plan
The travelers can change their ${days}-day itinerary through you. When their message asks for a change to it (or says yes to a change you suggested), write one or two sentences on what will change, then end your reply with one last line exactly like this:
CHANGE: {"title": "a short headline of the change, under 60 characters", "days": [3], "request": "the precise instruction for the planner, in English, with every detail agreed in the conversation"}
"days" lists the day numbers the change touches (several when it moves things between days, [] when it changes the whole trip).
Small edits don't need the planner: adding a stop at a time that's free and close to that day's other stops (a few minutes away, so nothing else has to move), removing a stop, or moving a stop to another time. A stop that is further away, or that pushes later stops, dinner or the drive back, is a "request" for the planner for that day ("add X at about 14:00 and re-plan the rest of the day around it"), never an "add". Write those as "stops" instead of "request" (and "days": []); the page makes them straight away, without re-planning the day:
CHANGE: {"days": [], "request": "", "stops": [{"op": "add", "day": 5, "time": "14:30", "place": "Aussichtsturm Gaflei", "where": "Gafleistrasse, Triesenberg, Liechtenstein", "description": "what it is and why go, how to get there, how long to allow", "cost": 0, "kind": "sight"}]}
Other ops: {"op": "remove", "day": 5, "place": "the stop's name exactly as in the plan"} and {"op": "time", "day": 5, "place": "the stop's name exactly as in the plan", "time": "08:00"} (e.g. breakfast moved to when the café opens). For an added stop, "where" is its address or "place, town, country" (it's looked up on the map, so it must be the real location). Use "request" instead when other stops would have to move or the day needs rearranging.
Add "trip" only when the trip's setup changes too (the day-by-day plan is made from it), with just the parts that change, for example: "trip": {"onTheWay": ["Burg Hohenwerfen"]}. Its parts:
- "onTheWay": places to visit on a travel day between two stays instead of as a day trip (this also takes them off the stays' day trips). Use it whenever they want a place "on the way".
- "fromStay": places to visit from where they sleep.
- "removeDayTrips": [{"stay": "town of the stay", "place": "place"}] and "addDayTrips": [{"stay": "town of the stay", "place": "place", "mode": "car|train|bus|walk|bike|ferry"}] for the day trips listed under the stays.
- "addPlaces": [{"name": "the place's real name", "where": "town, country", "must": true}] adds places to their places (for example one you recognised in a picture they sent), as a must-see when they want to go for sure.
- "removeMust": ["place"] takes places off their must-see list (the place stays among their ideas, it just isn't required any more). Use it when they say they no longer need or want to see a must-see, or when the conversation settles that it can't work (they swapped it for something else, it's closed on the days there, it's far off the route and they agreed to drop it). Use the place's name exactly as in "What they want to see" or their must-see list above; for a stop that is only in the day plan (not a must-see), change the day instead.
- "rescaleCosts": {"from": 2, "to": 3, "days": [2, 3], "after": "14:00"} works the plan's costs out again for a different number of travelers, without re-planning (leave out "days" for the whole trip). When someone joins or leaves for part of the trip, list only the days they're there, and "after": the time they join on the first of those days (what's before it, such as stops on the drive there, stays as it is); ask when they join if it isn't clear. Never change costs one by one with "setCost" for a change in travelers. For "rescaleCosts": meals, tickets and fares are per person and scale; the car, parking and fuel stay as they are. Use it when the number of travelers changed and they want the costs to match ("from" is the number the plan was made for: the trip says so when it's known, otherwise ask). A change that is only about costs or numbers never goes to the planner ("request" stays empty).
"edits" changes anything else you can change by hand, straight away and without re-planning; a list of these (use the names exactly as in the trip above):
- {"op": "set", "field": "travelers" | "dailyBudget" (per person) | "currency" (ISO code) | "pace" ("relaxed" | "balanced" | "packed") | "fitness" ("easy" | "average" | "fit") | "dayStart" ("09:00", "" for any) | "breakfast" ("hotel" | "out" | "brunch" | "skip") | "interests" | "wishes", "value": …}
- {"op": "stayNights", "stay": "town", "nights": 3}, {"op": "stayHotel", "stay": "town", "value": "hotel name"}, {"op": "stayTravel", "stay": "town", "value": "car|train|bus|walk|bike|ferry|flight"} (how they get there), {"op": "addStay", "city": "town, country", "after": "town it comes after", "nights": 2}, {"op": "removeStay", "stay": "town"}
- {"op": "moveStop", "day": 3, "place": "the stop's name as in the plan", "toDay": 4, "time": "14:00"}, {"op": "swapDays", "day": 3, "toDay": 4} (what they do on two days, swapped; dates stay), {"op": "setCost", "day": 2, "place": "the stop", "value": 30}
- {"op": "addBooking", "name": "what", "date": "YYYY-MM-DD", "from": "HH:MM", "to": "HH:MM"}, {"op": "removeBooking", "name": "what"} (things they have booked)
- {"op": "booked", "item": "the entry as in the Book ahead list", "done": true} ticks an entry of their "Book ahead" checklist off ("done": false unticks it); look up "bookings" first for the entries
- {"op": "packed", "item": "the item as in the packing list", "done": true} ticks a packing item ("done": false unticks it), {"op": "packAdd", "value": "item"} and {"op": "packRemove", "value": "item"} (only their own items); look up "packing" first
- {"op": "must", "place": "place"}, {"op": "skip", "place": "place"} (one of their places they don't want)
- {"op": "setCar", "fuel": "petrol|diesel|electric|", "per100": 6.5}
- {"op": "note", "value": "a sentence for their notes for the plan"} (a lasting preference they state, e.g. "No drives over 4 hours a day": offer to remember it this way), {"op": "idea", "value": "a line for their ideas & notes"}
Changing stays (nights, adding or removing one) doesn't re-plan the days: say they may want to re-plan the days concerned afterwards. A "what if…" question: answer with what it would mean (look up what you need), then offer it as a change; the travelers can compare before and after before they apply it.
Day trips listed under the stays above stay in the trip until removed here, even if a day's plan changes, so when a place moves from a day trip to somewhere else, remove that day trip too. When only the setup changes and the days are already right, use "days": [] and "request": "".
Only add the CHANGE line when they asked for a change, not for questions or for ideas they haven't asked for; if what they want is unclear, ask instead. Never offer a change for a place you couldn't identify: if you don't know what or where a place is (and a lookup didn't settle it), say so and ask them (for its address, or a link), and offer the change once you know. Always answer in words first: the CHANGE line is never the whole reply.
` : `
## Changing the trip before there's a plan
There's no day-by-day itinerary yet, but you can change the trip's setup, which the plan will be made from: add places to their must-sees (a place they want to see, or one you recognised in a picture), say whether a must-see is visited on the way between stays or from a stay, and add or remove the stays' day trips. When they ask for that (or say yes to it), write one or two sentences on what will change, then end your reply with one last line exactly like this:
CHANGE: {"days": [], "request": "", "trip": {"addPlaces": [{"name": "the place's real name", "where": "town, country", "must": true}]}}
"trip" can have:
- "addPlaces": [{"name": "…", "where": "town, country", "must": true}] adds places to their places, as must-sees when they want to go for sure ("must": false for an idea).
- "removeMust": ["place"] takes places off their must-see list (they stay among their ideas), when they say they no longer need to see them or the conversation settles that it can't work.
- "onTheWay": ["place"] visits a must-see on a travel day between two stays; "fromStay": ["place"] from where they sleep.
- "removeDayTrips": [{"stay": "town of the stay", "place": "place"}] and "addDayTrips": [{"stay": "town of the stay", "place": "place", "mode": "car|train|bus|walk|bike|ferry"}].
"edits" (see the list below) changes the rest of the setup: travelers, budget, pace, stays, bookings, their car, notes. For example: CHANGE: {"days": [], "request": "", "edits": [{"op": "set", "field": "travelers", "value": 2}]}
"edits" changes anything else you can change by hand, straight away and without re-planning; a list of these (use the names exactly as in the trip above):
- {"op": "set", "field": "travelers" | "dailyBudget" (per person) | "currency" (ISO code) | "pace" ("relaxed" | "balanced" | "packed") | "fitness" ("easy" | "average" | "fit") | "dayStart" ("09:00", "" for any) | "breakfast" ("hotel" | "out" | "brunch" | "skip") | "interests" | "wishes", "value": …}
- {"op": "stayNights", "stay": "town", "nights": 3}, {"op": "stayHotel", "stay": "town", "value": "hotel name"}, {"op": "stayTravel", "stay": "town", "value": "car|train|bus|walk|bike|ferry|flight"} (how they get there), {"op": "addStay", "city": "town, country", "after": "town it comes after", "nights": 2}, {"op": "removeStay", "stay": "town"}
- {"op": "moveStop", "day": 3, "place": "the stop's name as in the plan", "toDay": 4, "time": "14:00"}, {"op": "swapDays", "day": 3, "toDay": 4} (what they do on two days, swapped; dates stay), {"op": "setCost", "day": 2, "place": "the stop", "value": 30}
- {"op": "addBooking", "name": "what", "date": "YYYY-MM-DD", "from": "HH:MM", "to": "HH:MM"}, {"op": "removeBooking", "name": "what"} (things they have booked)
- {"op": "booked", "item": "the entry as in the Book ahead list", "done": true} ticks an entry of their "Book ahead" checklist off ("done": false unticks it); look up "bookings" first for the entries
- {"op": "packed", "item": "the item as in the packing list", "done": true} ticks a packing item ("done": false unticks it), {"op": "packAdd", "value": "item"} and {"op": "packRemove", "value": "item"} (only their own items); look up "packing" first
- {"op": "must", "place": "place"}, {"op": "skip", "place": "place"} (one of their places they don't want)
- {"op": "setCar", "fuel": "petrol|diesel|electric|", "per100": 6.5}
- {"op": "note", "value": "a sentence for their notes for the plan"} (a lasting preference they state, e.g. "No drives over 4 hours a day": offer to remember it this way), {"op": "idea", "value": "a line for their ideas & notes"}
Changing stays (nights, adding or removing one) doesn't re-plan the days: say they may want to re-plan the days concerned afterwards. A "what if…" question: answer with what it would mean (look up what you need), then offer it as a change; the travelers can compare before and after before they apply it.
Use the place's real name and where it is (look it up first if you aren't sure). For anything about the days themselves (what's on which day), tell them to generate the itinerary first. Only add the CHANGE line when they asked for a change; always answer in words first.
`;
  return `You are the travel companion for the trip below: a friendly, well-travelled local expert the travelers can ask anything about their trip, before or during it.

## The trip
${clip(req.context, MAX_CONTEXT) || "(Nothing planned yet: no stays or itinerary.)"}

## Looking things up
When you aren't sure about a place (what it is, where it is, how far it is, whether it's open, how to get there), look it up instead of guessing. To do that, reply with nothing but lookup lines; you'll get the results and be asked again (up to ${MAX_ROUNDS} rounds, at most 3 lines each):
LOOKUP: place | Gaflei, Liechtenstein
LOOKUP: route | Vaduz | Gaflei, Triesenberg
LOOKUP: route | Stuttgart | Hechingen | Lindau
LOOKUP: search | Aussichtsturm Gaflei opening hours${topics.length ? `
LOOKUP: trip | ${topics[0]}` : ""}
"place" finds where a place is on OpenStreetMap (address, coordinates, how far from the trip's towns); "route" gives the driving distance and time between places, the same road routing the map uses (with three or more places it drives through them in order and adds the total); "search" searches the web. Don't look up what the trip above already says.${topics.length ? ` "trip" gives what the planner page itself knows beyond the trip above: ${topics.join(", ")}. Use it for questions about these (and "check my plan": look up "checks", "costs" and "fuel").` : ""}
Distances and driving times: never state one from memory, and never write one into a CHANGE. Look every leg up with "route" first (it's quick), and use exactly the figures it returns. If a change makes a drive longer or shorter, say by how much, from the lookup, and mention it when a day then doesn't fit.

## How to answer
- Answer from the trip above when the question is about it (dates, days, stops, stays, costs, bookings, their ideas notes). Say which day or stay you mean.
- Only state what you know or looked up. If you're unsure, say so plainly in the answer (not only in your thinking) and ask rather than describe a place confidently.
- For anything else (food, getting around, what's worth it, weather, customs, packing, alternatives) use what you know about the places; say when something is worth checking (opening hours, prices and timetables change).
- Be concrete and brief: a few sentences or a short list. Suggest a change to the plan when it helps.
- Plain text with light Markdown only (**bold**, "- " bullets). No tables.
- Answer in the language the traveler writes in.
- Opening hours, prices and timetables you didn't look up (and that the trip doesn't give): say they're unverified and worth checking, rather than stating them as facts.
- Don't write links or a list of sources yourself: the page adds the pages, places and routes you looked up under your answer, with map links.${req.today ? `\n- Today is ${clip(req.today, 20)}.` : ""}
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
    const edits = editOps(c.edits, days);
    if (!request && !trip && !stops && !edits) return null;
    const list = (Array.isArray(c.days) ? c.days : []).map(Number).filter((d: number) => Number.isInteger(d) && d >= 1 && (!days || d <= days));
    const title = typeof c.title === "string" ? c.title.trim().slice(0, 80) : "";
    return { days: request ? [...new Set<number>(list)].sort((a, b) => a - b) : [], request, ...(trip ? { trip } : {}), ...(stops ? { stops } : {}), ...(edits ? { edits } : {}), ...(title ? { title } : {}) };
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
async function locateStops(stops: StopOp[], dayAt: Record<string, [number, number]> = {}) {
  for (const s of stops.filter((x) => x.op === "add")) {
    // First around where they sleep that day (a "Gasthaus Muster" by Bregenz, not the one near Bayreuth), then anywhere.
    const near = Array.isArray(dayAt[s.day]) && dayAt[s.day].length === 2 && dayAt[s.day].every(Number.isFinite) ? dayAt[s.day] : null;
    const tries: [string, [number, number] | null][] = [[s.where || s.place, near], ...(s.where ? [[s.place, near]] as [string, [number, number] | null][] : []), ...(near ? [[s.where || s.place, null]] as [string, null][] : [])];
    for (const [q, at] of tries) {
      const hit = await geocodeOne(q, undefined, at).catch(() => null);
      if (hit) { s.lat = hit.lat; s.lng = hit.lng; break; }
    }
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
    removeMust: names(t.removeMust),
    addPlaces: (Array.isArray(t.addPlaces) ? t.addPlaces : []).map((x: any) => ({ name: name(x?.name), where: name(x?.where), must: x?.must !== false })).filter((x: any) => x.name).slice(0, 10),
  };
  for (const k of Object.keys(ops) as (keyof TripOps)[]) if (!(ops[k] as unknown[]).length) delete ops[k];
  const from = Number(t.rescaleCosts?.from), to = Number(t.rescaleCosts?.to);
  if ([from, to].every((n) => Number.isInteger(n) && n >= 1 && n <= 30) && from !== to) {
    const days = (Array.isArray(t.rescaleCosts.days) ? t.rescaleCosts.days : []).map(Number).filter((d: number) => Number.isInteger(d) && d >= 1).slice(0, 60);
    const after = /^\d{1,2}:\d{2}$/.test(String(t.rescaleCosts.after || "")) ? String(t.rescaleCosts.after).padStart(5, "0") : "";
    ops.rescaleCosts = { from, to, ...(days.length ? { days } : {}), ...(after && days.length ? { after } : {}) };
  }
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

/** A summary as "- " bullets, also when the model answered with JSON ({"summary": [...]}). */
export function summaryText(text: string) {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!/^[[{]/.test(t)) return text.trim();
  try {
    const j = JSON.parse(t);
    const v = Array.isArray(j) ? j : j.summary ?? j.bullets ?? j.points ?? Object.values(j)[0];
    const list = (Array.isArray(v) ? v : String(v ?? "").split("\n")).map((x) => String(x).trim().replace(/^[-*•]\s*/, "")).filter(Boolean);
    return list.map((x) => `- ${x}`).join("\n");
  } catch { return text.trim(); }
}

export async function compactChat(req: { model: string; turns?: CompanionTurn[]; summary?: string }, report: Report, signal?: AbortSignal) {
  const turns = (Array.isArray(req.turns) ? req.turns : []).slice(-200);
  if (!turns.length) return { summary: req.summary || "" };
  report({ type: "status", text: "Summarizing the earlier conversation…" });
  const summary = summaryText(cleanAnswer(await askModel(req.model, compactPrompt(turns, req.summary), (n) => report({ type: "tokens", n }), {
    signal, text: true, nudge: "Write the summary right away.",
  })));
  if (!summary) throw new Error("The model didn't write a summary.");
  return { summary: summary.slice(0, 8_000) };
}

/** Distances or driving times in a draft ("350 km", "~3.5-4h", "2 hours of driving") that a route lookup hasn't checked. */
export const statesFigures = (text: string) => /\b\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:km|kilomet(?:er|re)s?|miles?)\b|\b\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:h|hrs?|hours?)\b(?!\s*(?:walk|hike))/i.test(text);

const FIG = /\b(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*(km|kilomet(?:er|re)s?|miles?|h|hrs?|hours?)\b(?:\s*(\d{1,2})\s*min\b)?(?!\s*(?:walk|hike))/gi;
const num = (s: string) => Number(s.replace(",", "."));
const unitOf = (u: string) => (/^k/i.test(u) ? "km" : /^mi/i.test(u) ? "mi" : "h");

/** The distances and driving times written in a text, with their numbers ("~3.5-4h" is 3.5 and 4 hours). */
export function figuresIn(text: string) {
  return [...text.matchAll(FIG)].map((m) => {
    const unit = unitOf(m[3]), extra = unit === "h" && m[4] ? Number(m[4]) / 60 : 0;
    return { raw: m[0].trim(), unit, values: [num(m[1]) + (m[2] ? 0 : extra), ...(m[2] ? [num(m[2]) + extra] : [])] };
  });
}

/** The figures in an answer that neither the trip nor a lookup result backs up (a total of two looked-up legs counts;
 *  rounding is fine: within 5 % or 5 km, half an hour). */
export function unverifiedFigures(text: string, known: string): string[] {
  const k: Record<string, number[]> = { km: [], mi: [], h: [] };
  for (const f of figuresIn(known)) k[f.unit].push(...f.values);
  for (const u of ["km", "h"]) {
    const list = k[u].slice(0, 16);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) k[u].push(list[i] + list[j]);
  }
  const close = (unit: string, v: number) => k[unit].some((x) => (unit === "h" ? Math.abs(x - v) <= 0.5 : Math.abs(x - v) <= Math.max(5, x * 0.05)));
  return [...new Set(figuresIn(text).filter((f) => !f.values.some((v) => close(f.unit, v))).map((f) => f.raw))];
}

export async function askCompanion(req: CompanionRequest, report: Report, signal?: AbortSignal) {
  report({ type: "status", text: "Thinking…" });
  // How long it thought: from the first thought to the first word of the answer.
  let thinking = "", earlier = "", thinkFrom = 0, thinkTo = 0;
  const images = cleanImages(req.images);
  const towns = (Array.isArray(req.towns) ? req.towns : []).filter((t) => t?.name && Number.isFinite(t.lat) && Number.isFinite(t.lng)).slice(0, 30);
  const looked: string[] = [], sources: Source[] = [];
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.data || {}).slice(0, 12)) if (typeof v === "string") data[k.slice(0, 30)] = v.slice(0, 12_000);
  let checked = false;
  // What figures may come from: the trip, what the traveler said, and every lookup result.
  let known = `${req.context || ""}\n${req.question || ""}\n${(req.history || []).filter((t) => t.role === "me").map((t) => t.text).join("\n")}`;
  const draft = (a: string) => `${cleanAnswer(a)}\n${parseChange(a, req.days || 0)?.request || ""}`;
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
    if (!lookups.length) {
      // A draft with distances or driving times, none of them looked up: it has to check them, not guess.
      const unsure = unverifiedFigures(draft(answer), known);
      if (!last && !checked && unsure.length) {
        prompt += `

## Your draft
${clip(answer, 4_000)}

These figures in it aren't in the trip or in any lookup result: ${unsure.join(", ")}. Don't guess them: reply now with LOOKUP: route lines for each drive involved (several places in one line drive through them in order), or leave the figures out of your answer. Then write the answer again.`;
        report({ type: "status", text: "Checking the distances…" });
        checked = true;
        continue;
      }
      break;
    }
    const results = await runLookups(lookups, towns, (text) => report({ type: "status", text }), sources, data);
    known += `\n${results}`;
    looked.push(...lookups.map((l) => `${l.kind}: ${l.args.join(" | ")}`));
    earlier = `${thinking}${thinking ? "\n\n" : ""}Looked up: ${lookups.map((l) => l.args.join(" → ")).join("; ")}\n\n`;
    thinking = earlier;
    report({ type: "thinking", text: thinking });
    prompt += `\n\n## Lookup results (round ${round + 1})\n${results}\n\nNow answer the traveler using these results${round + 1 < MAX_ROUNDS ? " (or look up something else, if you still need to)" : ""}.`;
  }
  // Figures nothing backs up are marked as such (in the answer, and for the planner), never passed off as facts.
  const unsure = unverifiedFigures(draft(answer), known);
  const text = cleanAnswer(answer) + (unsure.length ? `\n\n*Not verified: ${unsure.join(", ")}. No lookup confirmed ${unsure.length > 1 ? "these" : "this"}, so treat ${unsure.length > 1 ? "them" : "it"} as unknown.*` : "");
  // Without a plan, only setup changes count (must-sees, day trips): nothing on the days to change yet.
  const parsed = parseChange(answer, req.days || 0);
  // Ask mode never changes anything, whatever the model wrote.
  const setup = parsed ? { trip: parsed.trip, edits: parsed.edits?.filter((e) => !PLAN_EDITS.includes(e.op)) } : null;
  const change = req.mode === "ask" ? null : req.days ? parsed
    : setup && (setup.trip || setup.edits?.length) ? { days: [], request: "", ...(setup.trip ? { trip: setup.trip } : {}), ...(setup.edits?.length ? { edits: setup.edits } : {}), ...(parsed!.title ? { title: parsed!.title } : {}) } : null;
  if (change?.request && unsure.length) change.request += ` (Not verified by a routing lookup: ${unsure.join(", ")}. Don't rely on these; use routed distances.)`;
  if (change?.stops) { report({ type: "status", text: "Finding the new stops on the map…" }); await locateStops(change.stops, req.dayAt || {}); }
  if (!text && !change) throw new Error("The model didn't answer properly (no text, only an empty change). Try again, or pick a different model in the chat's menu.");
  const thought = thinking.trim() ? { thinking: thinking.trim().slice(-20_000), thoughtSecs: Math.max(1, Math.round(((thinkTo || Date.now()) - thinkFrom) / 1000)) } : {};
  return { answer: text || "I'll change that.", ...(change ? { change } : {}), ...(looked.length ? { lookups: looked } : {}), ...(sources.length ? { sources: sources.slice(0, 12) } : {}), ...thought };
}
