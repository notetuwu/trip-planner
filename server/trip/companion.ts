// The trip chat: questions about the trip on screen ("what's on Thursday?", "where can we eat near the castle?", "is
// two nights in Salzburg enough?"), answered by the selected model from what the page sends about the trip (stays,
// the itinerary, must-sees, the ideas notes) and the conversation so far. Plain text back, streamed as it's written.
// Asked to change the plan ("swap days 3 and 4", "a vegan lunch on day 2"), it says what it will change and hands
// back the change for the page to offer: re-planning the day concerned, or the whole plan.
// Nothing from here goes into plan generation: the chat is its own request, with its own prompt.
import { askModel } from "../ai/ask";
import type { Report } from "../util/progress-stream";

export interface CompanionTurn { role: "me" | "ai"; text: string }
export interface CompanionRequest {
  model: string;
  question: string;
  context?: string;
  history?: CompanionTurn[];
  today?: string;
  /** How many days the itinerary has (0: none yet, so no changes to offer). */
  days?: number;
}
/** A change to the plan the traveler asked for: the days it touches (1-based; empty = all over the plan) and the
 *  instruction for the planner. */
export interface PlanChange { days: number[]; request: string; trip?: TripOps }
/** Changes to the trip's setup (not the day-by-day plan): how must-sees are fitted in, and the stays' day trips. */
export interface TripOps {
  /** Visit on a travel day between stays (this also takes them off the stays' day trips). */
  onTheWay?: string[];
  /** Visit from where they sleep. */
  fromStay?: string[];
  removeDayTrips?: { stay: string; place: string }[];
  addDayTrips?: { stay: string; place: string; mode: string }[];
}

const MAX_CONTEXT = 60_000, MAX_TURN = 4_000;
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export function companionPrompt(req: CompanionRequest) {
  const history = (Array.isArray(req.history) ? req.history : []).slice(-12)
    .map((t) => `${t.role === "me" ? "Traveler" : "You"}: ${clip(t.text, MAX_TURN)}`).join("\n\n");
  const days = Number(req.days) || 0;
  const changes = days ? `
## Changing the plan
The travelers can change their ${days}-day itinerary through you. When their message asks for a change to it (or says yes to a change you suggested), write one or two sentences on what will change, then end your reply with one last line exactly like this:
CHANGE: {"days": [3], "request": "the precise instruction for the planner, in English, with every detail agreed in the conversation", "trip": {"onTheWay": [], "fromStay": [], "removeDayTrips": [], "addDayTrips": []}}
"days" lists the day numbers the change touches (several when it moves things between days, [] when it changes the whole trip).
"trip" changes the trip's setup, which the day-by-day plan is made from (leave it out when nothing there changes):
- "onTheWay": places to visit on a travel day between two stays instead of as a day trip (this also takes them off the stays' day trips). Use it whenever they want a place "on the way".
- "fromStay": places to visit from where they sleep.
- "removeDayTrips": [{"stay": "town of the stay", "place": "place"}] and "addDayTrips": [{"stay": "town of the stay", "place": "place", "mode": "car|train|bus|walk|bike|ferry"}] for the day trips listed under the stays.
Day trips listed under the stays above stay in the trip until removed here, even if a day's plan changes, so when a place moves from a day trip to somewhere else, remove that day trip too. When only the setup changes and the days are already right, use "days": [] and "request": "".
Only add the CHANGE line when they asked for a change, not for questions or for ideas they haven't asked for; if what they want is unclear, ask instead.
` : `
There's no itinerary yet: if they ask to change the plan, tell them to generate one first (or what to put in the form).
`;
  return `You are the travel companion for the trip below: a friendly, well-travelled local expert the travelers can ask anything about their trip, before or during it.

## The trip
${clip(req.context, MAX_CONTEXT) || "(Nothing planned yet: no stays or itinerary.)"}

## How to answer
- Answer from the trip above when the question is about it (dates, days, stops, stays, costs, bookings, their ideas notes). Say which day or stay you mean.
- For anything else (food, getting around, what's worth it, weather, customs, packing, alternatives) use what you know about the places; say when something is worth checking (opening hours, prices and timetables change).
- Be concrete and brief: a few sentences or a short list. Suggest a change to the plan when it helps.
- Plain text with light Markdown only (**bold**, "- " bullets). No tables.
- Answer in the language the traveler writes in.${req.today ? `\n- Today is ${clip(req.today, 20)}.` : ""}
${changes}${history ? `\n## The conversation so far\n${history}\n` : ""}
## The traveler says
${clip(req.question, MAX_TURN)}`;
}

/** Strips what some models wrap answers in (a code fence, a leading "You:") and the CHANGE line (also half-written). */
export const cleanAnswer = (text: string) =>
  text.trim().replace(/^```(?:\w+)?\n([\s\S]*?)\n```$/, "$1").replace(/^(You|Assistant|Companion):\s*/i, "")
    .replace(/\n?[ \t`*]*CHANGE:[\s\S]*$/, "").replace(/\n[ \t]*C(H(A(N(G(E)?)?)?)?)?$/, "").trim();

/** The change at the end of a reply, if there's a valid one. */
export function parseChange(text: string, days = 0): PlanChange | null {
  const m = text.match(/CHANGE:\s*(\{[\s\S]*\})/);
  if (!m) return null;
  try {
    const c = JSON.parse(m[1]);
    const request = String(c.request || "").trim().slice(0, 2000);
    const trip = tripOps(c.trip);
    if (!request && !trip) return null;
    const list = (Array.isArray(c.days) ? c.days : []).map(Number).filter((d: number) => Number.isInteger(d) && d >= 1 && (!days || d <= days));
    return { days: request ? [...new Set<number>(list)].sort((a, b) => a - b) : [], request, ...(trip ? { trip } : {}) };
  } catch { return null; }
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
  };
  for (const k of Object.keys(ops) as (keyof TripOps)[]) if (!ops[k]!.length) delete ops[k];
  return Object.keys(ops).length ? ops : null;
}

export async function askCompanion(req: CompanionRequest, report: Report, signal?: AbortSignal) {
  report({ type: "status", text: "Thinking…" });
  const answer = await askModel(req.model, companionPrompt(req), (n) => report({ type: "tokens", n }), {
    signal,
    nudge: "Answer the traveler right away, briefly.",
    // The answer so far goes out as it's written (as "reasoning", the channel the page already shows live).
    onText: (reply, thinking) => {
      if (reply.trim()) report({ type: "reasoning", text: cleanAnswer(reply) });
      else if (thinking) report({ type: "status", text: "Thinking…" });
    },
    onRetry: (message) => report({ type: "status", text: message }),
  });
  const text = cleanAnswer(answer);
  const change = req.days ? parseChange(answer, req.days) : null;
  if (!text && !change) throw new Error("The model didn't answer. Try again, or pick a different model.");
  return { answer: text || "I'll change that.", ...(change ? { change } : {}) };
}
