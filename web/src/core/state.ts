// The trip being edited (saved in localStorage) plus session-only data such as the loaded place list.
import type { DayTrip, Itinerary, ListSummary, Place, Poi, TravelMode } from "../../../shared/types";

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
}

export type Mark = "must" | "skip";

export interface AppState {
  stays: Stay[];
  dailyBudget: number;
  currency: string;
  travelers: number;
  pace: string;
  model: string;
  interests: string;
  notes: string;
  list: string;
  /** The user picked a list (or none) themselves, so don't default to the first one. */
  listChosen: boolean;
  marks: Record<string, Mark>;
  /** How many travelers want each must-see (when not everyone). */
  who: Record<string, number>;
  customPlaces: Place[];
  itinerary: Itinerary | null;
  meta: Meta | null;
  research?: boolean;
  /** Things to book that the travelers ticked off, by "date|place". */
  booked?: Record<string, boolean>;
}

const STORE_KEY = "trip-planner-v2";

export const blankTrip = (): AppState => ({
  stays: [{ city: "", start: "", nights: 3, hotel: "" }],
  dailyBudget: 150, currency: "EUR", travelers: 1, pace: "balanced (3-5 stops per day)",
  model: "default", interests: "", notes: "", list: "", listChosen: false, marks: {}, who: {}, customPlaces: [], itinerary: null, meta: null,
});

function load(): Partial<AppState> | null {
  for (const key of [STORE_KEY, "japan-planner-v1"]) {
    try { const s = JSON.parse(localStorage.getItem(key) || "null"); if (s) return s; } catch { /* corrupt */ }
  }
  return null;
}

export let state: AppState = { ...blankTrip(), ...load() };

/** Replaces the whole trip, starting from a blank one so nothing (like an old itinerary) leaks in. */
export function setState(next: Partial<AppState>) {
  state = { ...blankTrip(), ...next };
}

export function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}

/** Data for this session only. */
export const session = {
  /** What the itinerary is filtered by (the search box above the days). */
  search: "",
  /** Which collapsible sections of the itinerary are open, by name. */
  folds: {} as Record<string, boolean>,
  /** Places of the selected list. */
  listPlaces: [] as Place[],
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
  session.places = [...list, ...state.customPlaces];
}

export const groupSize = () => Math.max(1, +state.travelers || 1);
/** How many travelers want a must-see place (defaults to everyone). */
export const whoFor = (title: string) => Math.min(state.who[title] || groupSize(), groupSize());
