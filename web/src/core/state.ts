// The trip being edited (saved in localStorage) plus session-only data such as the loaded place list.
import type { DayTrip, Itinerary, ListSummary, MustSeeHow, Place, Poi, TravelMode, Booking } from "../../../shared/types";
import { prefs } from "./prefs";

export interface Stay {
  city: string;
  start: string;
  nights: number;
  hotel: string;
  /** The arrival date was set by hand instead of following the previous stay. */
  manualStart?: boolean;
  travel?: TravelMode;
  dayTrips?: DayTrip[];
}

export interface Lookup { query?: string; url?: string }
export interface PromptPart { label: string; info?: string; text: string }

/** What came with the generated itinerary (shown under it and used to place pins). */
export interface Meta {
  costUsd?: number;
  durationMs?: number;
  reasoning?: string;
  thinking?: string;
  lookups?: Lookup[];
  prompt?: PromptPart[];
  pois?: Poi[];
  tokens?: number;
  perSec?: number;
  engine?: string;
  local?: boolean;
  billing?: "plan" | "api" | "local";
  searches?: number;
  budget?: number;
  currency?: string;
  at?: string;
  /** The stays the plan was made for (town, arrival, nights), to tell when they've changed since. */
  staysKey?: string;
}

export type Mark = "must" | "skip";

export interface AppState {
  stays: Stay[];
  /** Budget a day, per person (older trips: for the whole group; see `perPerson`). */
  dailyBudget: number;
  /** "person": dailyBudget is per person (older trips had the group's budget). */
  budgetPer?: "person";
  currency: string;
  travelers: number;
  pace: string;
  /** How much walking and climbing the plan can ask of them. */
  fitness?: "easy" | "average" | "fit";
  /** When a normal day starts ("10:00"; "" as the pace suits), and what they do for breakfast. */
  dayStart?: string;
  breakfast?: "" | "hotel" | "out" | "brunch" | "skip";
  model: string;
  interests: string;
  /** What they want to see ("the must-sees plus hidden gems"); the route planner fills it from its description. */
  wishes: string;
  /** The route planner description last put into wishes, so a new route replaces it rather than piling up. */
  lastRouteWhat?: string;
  notes: string;
  /** The first ticked place list (older trips had only this one). */
  list: string;
  /** The ticked place lists: their places show on the map and under Places. */
  lists?: string[];
  /** Per list: the planner may pick from its places as suggestions (unset: yes); off: only its starred places go. */
  listSuggest?: Record<string, boolean>;
  /** The user picked a list (or none) themselves, so don't default to the first one. */
  listChosen: boolean;
  marks: Record<string, Mark>;
  /** How many travelers want each must-see (when not everyone). */
  who: Record<string, number>;
  /** Must-sees the travelers want on the way between stays or from a stay (unset: decided by the route). */
  how?: Record<string, MustSeeHow>;
  customPlaces: Place[];
  /** Copies of must-see places from place lists, so they stay part of the trip whichever list is chosen. */
  kept?: Place[];
  itinerary: Itinerary | null;
  meta: Meta | null;
  research?: boolean;
  /** After a plan, send what the map and opening-hours checks find back to the model to fix (default on). */
  autoFix?: boolean;
  /** After a plan, look up opening hours on the web for stops OpenStreetMap has none for, and check each stay's days. */
  hoursOnline?: boolean;
  /** Things to book that the travelers ticked off, by "date|place". */
  booked?: Record<string, boolean>;
  /** Packing list: ticked items, and items the travelers added themselves. */
  packed?: Record<string, boolean>;
  packingExtra?: string[];
  /** Brainstorming notes (Ideas & notes): for the travelers and the trip chat, not sent with a plan. */
  ideas?: string;
  /** Long chats are compacted: a summary of the first `chatSummarized` messages, sent instead of them. */
  chatSummary?: string;
  chatSummarized?: number;
  /** The model that answers in the trip chat ("" or unset: the planning model). */
  chatModel?: string;
  /** Their car, for the fuel estimate: fuel type, consumption (litres or kWh per 100 km), a price per kWh for an
   *  electric car, and fuel prices they set themselves per country (EUR a litre; otherwise the weekly averages). */
  car?: { fuel: "" | "petrol" | "diesel" | "electric"; per100: number; kwhPrice?: number; prices?: Record<string, number> };
  /** The model that plans routes in "Plan a route" ("" or unset: the planning model). */
  routeModel?: string;
  /** Things already booked (Bookings in the sidebar). */
  bookings?: Booking[];
  /** The saved trip this one is (set by Save, Load and saving by itself), so saving by itself updates that one. */
  saveName?: string;
  /** The trip chat so far. */
  chat?: { role: "me" | "ai"; text: string; images?: string[]; thinking?: string; thoughtSecs?: number; change?: { days: number[]; request: string; trip?: { onTheWay?: string[]; fromStay?: string[]; removeDayTrips?: { stay: string; place: string }[]; addDayTrips?: { stay: string; place: string; mode: string }[]; addPlaces?: { name: string; where: string; must: boolean }[]; removeMust?: string[] }; status?: "offered" | "applying" | "applied" | "failed" | "skipped" | "undone" } }[];
}

const STORE_KEY = "trip-planner-v2";

/** An empty trip, with what Settings → General says a new trip starts with. */
export const blankTrip = (): AppState => ({
  stays: [{ city: "", start: "", nights: 3, hotel: "" }],
  dailyBudget: prefs.app.newTrip.dailyBudget, budgetPer: "person", currency: prefs.app.newTrip.currency, travelers: prefs.app.newTrip.travelers, pace: prefs.app.newTrip.pace, fitness: "average", dayStart: "", breakfast: "",
  model: "default", interests: "", wishes: "", notes: "", list: "", listChosen: false, marks: {}, who: {}, customPlaces: [], itinerary: null, meta: null,
});

function load(): Partial<AppState> | null {
  for (const key of [STORE_KEY, "japan-planner-v1"]) {
    try { const s = JSON.parse(localStorage.getItem(key) || "null"); if (s) return s; } catch { /* corrupt */ }
  }
  return null;
}

/** Older trips had the group's budget a day; now it's per person (320 for 4 travelers becomes 80). */
function perPerson(next: Partial<AppState> | null): AppState {
  const s = { ...blankTrip(), ...next };
  if (next?.dailyBudget == null || next.budgetPer === "person") return { ...s, budgetPer: "person" };
  return { ...s, dailyBudget: Math.round((Number(next.dailyBudget) || 0) / Math.max(1, Number(s.travelers) || 1)), budgetPer: "person" };
}

export let state: AppState = perPerson(load());

/** Replaces the whole trip, starting from a blank one so nothing (like an old itinerary) leaks in. */
export function setState(next: Partial<AppState>) {
  state = perPerson(next);
}

const saveHooks: (() => void)[] = [];
/** Called after every save (sharing the trip with other windows and devices, see sync.ts). */
export const onSave = (fn: () => void) => { saveHooks.push(fn); };

export function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
  for (const fn of saveHooks) fn();
}

/** Data for this session only. */
export const session = {
  /** Stays folded in the itinerary (by stay index): only their heading shows. */
  foldedStays: new Set<number>(),
  /** What the itinerary is filtered by (the search box above the days). */
  search: "",
  /** Which collapsible sections of the itinerary are open, by name. */
  folds: {} as Record<string, boolean>,
  /** Places of the selected list. */
  listPlaces: [] as Place[],
  /** Titles of the places from lists suggested to the planner (the rest only go when starred). */
  fullTitles: new Set<string>(),
  /** listPlaces plus the places picked on the map (state.customPlaces). */
  places: [] as Place[],
  /** List summaries from the server. */
  lists: [] as ListSummary[],
  /** Forecast by date. */
  weather: {} as Record<string, { code: number; max: number; min: number }>,
  /** The day shown on its own on the map, or null for all days. */
  selectedDay: null as number | null,
  /** The user panned or zoomed, so stop auto-fitting the map. */
  userMoved: false,
};

export function setListPlaces(list: Place[]) {
  session.listPlaces = list;
  // Must-sees from the list are copied into the trip, so they stay when another list (or none) is chosen.
  for (const p of list) if (state.marks[p.title] === "must") keepPlace(p);
  const shown = new Set([...list, ...state.customPlaces].map((p) => p.title));
  session.places = [...list, ...state.customPlaces, ...(state.kept || []).filter((p) => !shown.has(p.title) && state.marks[p.title] === "must")];
}

/** Keeps (or refreshes) the trip's own copy of a must-see place from a place list. */
export function keepPlace(p: Place) {
  if (p.custom) return;
  const { title, note, url, tags, comment, address, lat, lng } = p;
  state.kept = [...(state.kept || []).filter((k) => k.title !== title), { title, note, url, tags, comment, address, lat, lng }];
}

/** Must-see places kept from place lists that aren't suggested to the planner (hidden, or suggestions off): sent along
 *  like map-picked places. */
export const keptElsewhere = () => (state.kept || []).filter((p) => !session.fullTitles.has(p.title) && state.marks[p.title] === "must");

/** Whether the planner may pick from a list's places as suggestions (else only the starred ones go). */
export const listSuggest = (name: string) => state.listSuggest?.[name] !== false;

/** The ticked place lists (older trips: their one list). */
export const tickedLists = () => state.lists ?? (state.list ? [state.list] : []);
export function setTickedLists(names: string[]) {
  state.lists = [...new Set(names)];
  state.list = state.lists[0] || "";
  state.listChosen = true;
}

/** The whole group's budget a day (what day costs are compared with). */
export const groupBudget = () => (Number(state.dailyBudget) || 0) * groupSize();

export const groupSize = () => Math.max(1, +state.travelers || 1);
/** How many travelers want a must-see place (defaults to everyone). */
export const whoFor = (title: string) => Math.min(state.who[title] || groupSize(), groupSize());

/** The stays in short (town, arrival, nights), to compare with the ones a plan was made for. */
export const staysKey = (stays: Stay[] = state.stays) =>
  JSON.stringify(stays.filter((s) => s.city.trim()).map((s) => [s.city.trim().toLowerCase(), s.start, +s.nights || 0]));
