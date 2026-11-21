// Types shared by the server and the browser app.

export interface Place {
  title: string;
  note?: string;
  url?: string;
  tags?: string;
  comment?: string;
  address?: string;
  lat?: number;
  lng?: number;
  /** Added by clicking the map rather than imported from a list. */
  custom?: boolean;
  /** Sent to the model for places picked on the map. */
  picked?: boolean;
}

export type ListSource = { type: "google"; url: string } | { type: "csv"; file: string } | { type: "upload" };

export interface PlaceList {
  name: string;
  title?: string;
  source?: ListSource;
  places: Place[];
  syncedAt?: string;
}

export interface ListSummary {
  name: string;
  title: string;
  count: number;
  source?: ListSource;
  syncedAt?: string;
}

/** How the travelers get between stays or on a day trip; "" lets the planner choose. */
export type TravelMode = "" | "car" | "train" | "bus" | "flight" | "ferry" | "bike";

export interface DayTrip {
  place: string;
  mode: TravelMode;
}

/** A stay as sent to the server: the city plus what the browser worked out about it. */
export interface TripStay {
  city: string;
  start: string;
  nights: number;
  hotel: string;
  country?: string;
  cc?: string;
  travel?: TravelMode;
  dayTrips?: DayTrip[];
}

export interface ItineraryItem {
  time: string;
  place: string;
  fromList?: boolean;
  description: string;
  cost?: number;
  transport?: string;
  lat?: number;
  lng?: number;
  group?: string;
  people?: number;
}

export interface Day {
  date: string;
  city: string;
  title: string;
  estimatedCost: number;
  items: ItineraryItem[];
  notes?: string;
}

export interface HolidayOrEvent {
  date: string;
  name: string;
  where?: string;
  impact: string;
}

export interface Itinerary {
  summary: string;
  destination?: string;
  localCurrency?: string;
  totalEstimatedCost: number;
  days: Day[];
  unused?: { place: string; reason: string }[];
  tips?: string[];
  holidaysAndEvents?: HolidayOrEvent[];
  sources?: string[];
  /** Local models write their notes here; the server moves them out before sending. */
  planningNotes?: string;
}

/** Body of POST /api/itinerary. */
export interface TripRequest {
  dailyBudget: number;
  currency: string;
  travelers: number;
  pace: string;
  model: string;
  interests: string;
  notes: string;
  list: string;
  extraPlaces: Place[];
  stays: TripStay[];
  research: boolean;
  mustSee: string[];
  mustSeeWho: Record<string, number>;
  skip: string[];
  revise?: { itinerary: Itinerary; request: string };
}

export interface GeoHit {
  lat: number;
  lng: number;
  name: string;
  label: string;
  country: string;
  cc: string;
  kind: string;
}

export interface ReverseHit {
  name: string;
  label: string;
  options: { name: string; level: "place" | "area" | "town" }[];
  short: string;
  city: string;
  cc: string;
}

export interface GeoQuery {
  q: string;
  cc?: string;
  near?: [number, number];
  /** Jump ahead of the saved-places backlog. */
  first?: boolean;
}

export type LatLng = [number, number];

/** A routed leg: distance (m), duration (s) and the path as [lat, lng] pairs. */
export interface Route {
  d: number;
  t: number;
  c: LatLng[];
}

export type RouteMode = "foot" | "car";

export interface Poi {
  name: string;
  lat: number;
  lng: number;
  city?: string;
}

export interface LocalModel {
  id: string;
  name: string;
  server: string;
  size?: number;
}

export interface RunResult {
  itinerary: Itinerary;
  reasoning: string;
  thinking?: string;
  costUsd?: number;
  durationMs: number;
  tokens?: number;
  perSec?: number;
  engine: string;
}

/** One line of the NDJSON stream from POST /api/itinerary. */
export type StreamEvent =
  | { type: "status"; text: string }
  | { type: "thinking"; tokens: number }
  | { type: "text"; text: string }
  | { type: "notes"; text: string }
  | { type: "thought"; text: string }
  | { type: "search"; query: string }
  | { type: "fetch"; url: string }
  | { type: "progress"; days: number }
  | { type: "prompt"; label: string; info?: string; text: string }
  | { type: "pois"; places: Poi[] }
  | { type: "tokens"; count: number; estimated: boolean; perSec?: number }
  | ({ type: "done" } & RunResult)
  | { type: "error"; error: string };

export interface SaveSummary {
  name: string;
  savedAt: string;
}
