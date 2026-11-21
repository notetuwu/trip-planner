// Types shared by the server and the browser app.
export type * from "./geo";
import type { Poi } from "./geo";

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
  /** Where the stay is (the hotel if found, else the town), as the browser located it. */
  lat?: number;
  lng?: number;
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
  kind?: "sight" | "activity" | "meal" | "transfer" | "other";
  /** For places with tickets, tours or reservations: how much booking ahead matters. */
  booking?: "essential" | "recommended" | "optional";
  /** How far ahead to book, e.g. "2-3 weeks before". */
  bookAhead?: string;
  /** The place's official website or ticket page, as the model gave it (checked to exist before it's shown). */
  website?: string;
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

/** A must-see on the way ("way") between stays, or visited from where you sleep ("stay"); unset = decide by the route. */
export type MustSeeHow = "way" | "stay";

export interface MustSeeRoute {
  how?: MustSeeHow;
  /** The pair of consecutive stays it adds the least detour to (straight-line km). */
  leg?: { from: string; to: string; date?: string; detourKm: number; legKm: number };
  /** The nearest stay with a night there. */
  base?: { city: string; km: number };
  /** Lies on the way closely enough to be a stop on the travel day. */
  onWay: boolean;
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
  /** Where each must-see sits on the route, and whether the travelers want it on the way or from a stay. */
  mustSeeRoute?: Record<string, MustSeeRoute>;
  skip: string[];
  revise?: { itinerary: Itinerary; request: string };
  /** Fix the problems the checks found (stops far from their day, closed at the planned time), keeping the rest. */
  fix?: { itinerary: Itinerary; problems: { day: number; text: string }[] };
  /** Re-plan one day (index into itinerary.days), keeping the rest. */
  redoDay?: { itinerary: Itinerary; day: number; request: string };
}

export type CloudProvider = "anthropic" | "openai" | "openrouter";

/** A model reached with an API key; id is "api|<provider>|<model>". */
export interface CloudModel {
  id: string;
  name: string;
  provider: CloudProvider;
}

export interface KeyStatus {
  set: boolean;
  /** "env" when it comes from an environment variable (or .env), "file" when saved from the page. */
  source: "env" | "file" | "";
  /** The key's last characters, to tell keys apart. */
  hint: string;
}

/** GET /api/models */
export interface ModelsResponse {
  claude: boolean;
  local: LocalModel[];
  cloud: CloudModel[];
  keys: Record<CloudProvider, KeyStatus>;
  /** Problems listing a provider's models, e.g. a rejected key. */
  errors: Partial<Record<CloudProvider, string>>;
  /** Whether Ollama is installed on this computer and answering (the planner starts it if it's installed). */
  ollama: { installed: boolean; running: boolean };
}

/** GET /api/gpu: the graphics card and its memory, for the local-model guide (null when unknown). */
export interface GpuInfo { name: string; memGb: number; unified?: boolean }

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
  /** How the run is paid for: Claude subscription, an API key, or free on this computer. */
  billing?: "plan" | "api" | "local";
  searches?: number;
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
