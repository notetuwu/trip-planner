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
  /** In the page: the list it came from (shown in Places). */
  from?: string;
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

/** Something already booked (a concert, an expo, timed tickets): planned around, always on its day. */
export interface Booking {
  name: string;
  /** YYYY-MM-DD: the day it's for, or the first day a ticket is valid. */
  date: string;
  /** YYYY-MM-DD: the last day a ticket is valid (an exhibition ticket for the 9th to the 13th), so the planner picks
   *  the best day in between. Unset: only `date`. */
  until?: string;
  /** Where it is: an address or place name, and its spot (picked on the map or from the suggestions). */
  where?: string;
  lat?: number;
  lng?: number;
  /** "HH:MM": when it starts, and optionally until when; without from, any time that day. */
  from?: string;
  to?: string;
  /** For the whole group, in the trip's currency. */
  cost?: number;
  /** Count the cost in that day's budget (otherwise it's already paid and shows as 0). */
  countCost?: boolean;
}

export interface DayTrip {
  place: string;
  mode: TravelMode;
  /** How many of the travelers go, when only part of the group does (the others spend the day elsewhere). */
  people?: number;
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
  /** Whether the cost grows with the number of travelers (tickets, meals, fares) or not (the car, parking, a taxi). */
  costPer?: "person" | "group";
  transport?: string;
  /** Where it is, for finding it on the map, when the name isn't the place itself ("Studio Retro exhibition" is at
   *  "Shibuya BEAM, Udagawachō, Shibuya"): the venue's name and area, or its address. Looked up before the name. */
  where?: string;
  lat?: number;
  lng?: number;
  group?: string;
  people?: number;
  /** Who does this stop, by name, while the group is apart (or only some meet up); none when everyone does it
   *  (shared/people.ts). Instead of "group" and "people" on trips whose travelers are named. */
  who?: string[];
  kind?: "sight" | "activity" | "meal" | "transfer" | "other";
  /** For places with tickets, tours or reservations: how much booking ahead matters. */
  booking?: "essential" | "recommended" | "optional";
  /** How far ahead to book, e.g. "2-3 weeks before". */
  bookAhead?: string;
  /** The place's official website or ticket page, as the model gave it (checked to exist before it's shown). */
  website?: string;
  /** One of their must-sees (the model wrote "MUST SEE" into the text; the page shows a tag instead). */
  mustSee?: boolean;
  /** lat/lng come from a real lookup (an address, a booking's spot, a stop added in the chat), not the model's guess. */
  fixed?: boolean;
  /** lat/lng were set by the travelers themselves ("Set location"): always where it is. */
  pinned?: boolean;
  /** How they get here from the stop before, set by the travelers themselves (the map otherwise reads it from
   *  "transport"): a mode for each part, through the places on the way (modes has one more entry than via). */
  leg?: { modes: LegChoice[]; via: { name: string; lat: number; lng: number }[] };
  /** The plan's own words for how they get here, from before the timetable's line replaced them (see shared/rides.ts):
   *  set once, so a stop is only ever updated by itself once. */
  transportWas?: string;
}

/** A part of a leg as the travelers set it: on foot, by bike, by road, by tram/metro/bus line, by train, by boat, by
 *  cable car/gondola/funicular, a flight (an arc), or a straight line (anything with no route). */
export type LegChoice = "foot" | "bike" | "car" | "bus" | "transit" | "train" | "ferry" | "lift" | "flight" | "straight";

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
  /** The day trip (from a stay to its day-trip place) it adds the least detour to. */
  trip?: { from: string; to: string; detourKm: number; legKm: number };
  /** Lies on the way of that day trip closely enough to be a stop on it (Onomichi on the way to Hiroshima). */
  onTrip?: boolean;
  /** Lies on the way closely enough to be a stop on the travel day. */
  onWay: boolean;
}

/** Body of POST /api/itinerary. */
export interface TripRequest {
  /** Per person when budgetPer is "person" (older pages sent the group's budget). */
  dailyBudget: number;
  budgetPer?: "person";
  currency: string;
  travelers: number;
  /** The travelers' names, when they gave them: splits are then said by name. */
  people?: string[];
  pace: string;
  /** How much walking and climbing the plan can ask of them (unset: average). */
  fitness?: "easy" | "average" | "fit";
  /** When a normal day starts, "HH:MM" ("" or unset: as the pace suits). */
  dayStart?: string;
  /** Breakfast at the hotel, out at a café, brunch instead, skipped ("" or unset: the planner decides). */
  breakfast?: "" | "hotel" | "out" | "brunch" | "skip";
  /** How they get around: public transport and the odd taxi, their car, or "" (the planner decides). */
  getAround?: "" | "transit" | "car";
  model: string;
  interests: string;
  /** What they want to see, in their words. */
  wishes?: string;
  /** Things already booked, planned around. */
  bookings?: Booking[];
  notes: string;
  /** The first ticked place list (older servers read only this). */
  list: string;
  /** All the ticked place lists: their places are merged. */
  lists?: string[];
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
  /** A change the travelers asked for (the trip chat), to these days only (0-based); only they come back, the rest stays.
   *  agreed: the stops they settled with the chat, which the planner keeps exactly (and which are put back if it doesn't). */
  edit?: { itinerary: Itinerary; days: number[]; request: string; agreed?: AgreedStop[] };
}

/** A stop the travelers and the chat settled on for a day: the planner keeps it as it is and fills in the details. */
export interface AgreedStop {
  /** The day's number in the plan (from 1), and its date (filled in by the page before it goes to the planner). */
  day: number;
  date?: string;
  time: string;
  place: string;
  where?: string;
  kind?: ItineraryItem["kind"];
  cost?: number;
  note?: string;
  /** While the group is split: which subgroup does this stop ("Group A") and how many of them; none when all go. */
  group?: string;
  people?: number;
  /** Who does it, by name (shared/people.ts); none when all go. */
  who?: string[];
}

export type CloudProvider = "anthropic" | "openai" | "openrouter" | "gemini";

/** GET /api/gemini: what's known about the Gemini key's tier and limits, and what this planner sent today. */
export interface GeminiStatus {
  set: boolean;
  /** free: the key's project has no billing (a free-tier quota, or "needs billing", answered); paid: billing is on;
   *  blocked: no billing and the free tier isn't offered in this region; unknown: couldn't tell. */
  tier: "free" | "paid" | "blocked" | "unknown";
  /** Why it's thought so, or why it couldn't be told. */
  tierNote: string;
  checkedAt: number;
  /** Google's quota day (midnight to midnight Pacific time) and when it next starts, in ms. */
  day: string;
  resetAt: number;
  /** Requests and tokens this planner sent today, per model, with the limits Google has told it about. */
  models: GeminiModelUse[];
  /** A limit that was hit and is still in effect. */
  limited: { model: string; perDay: boolean; limit?: number; until: number } | null;
  /** What each model in Google's catalog answered to a test request: only "ok" ones are offered in the Model menu. */
  access: GeminiAccess[];
  /** Exact limits read from the Google Cloud project (Settings → Google), and why they couldn't be ("" = fine, or not
   *  set up). With them, models' perDay / perMinute are the project's quotas (-1: unlimited). */
  exact: { project: string; billing: boolean | null } | null;
  exactError: string;
}
/** ok: it answered (usable); billing: none on this key's tier (a quota of 0, or "needs billing"); gone: retired or not
 *  offered to this key; unknown: some other answer. */
export interface GeminiAccess { model: string; state: "ok" | "billing" | "gone" | "unknown"; note: string }
export interface GeminiModelUse { model: string; requests: number; tokens: number; perDay?: number; perMinute?: number }

/** GET /api/usage: a warning that a model's usage is critical (warn: nearly there; out: used up). */
export interface UsageNotice { level: "warn" | "out"; text: string; resetsAt?: number; url?: string }
/** One limit and how much of it is used (percent, 0-100). model: it only counts for that model ("opus"); near: the
 *  service itself calls it close. */
export interface UsageLimit { name: string; percent: number; resetsAt?: number; model?: string; near?: boolean }
/** GET /api/usage: the warning, and for Claude (plan or API key) the limits shown under the Model menu. */
export interface UsageInfo {
  notice: UsageNotice | null;
  limits?: {
    /** "Pro plan", "Anthropic API, per minute at the last request". */
    title: string;
    list: UsageLimit[];
    /** Paid usage beyond the plan: money spent of the monthly cap. */
    extra?: { used: number; cap: number; currency: string };
    /** Said instead of a list when nothing is known yet. */
    note?: string;
    url: string;
  };
}

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
  /** How the run is paid for: Claude subscription, an API key, an API key on a free tier, or free on this computer. */
  billing?: "plan" | "api" | "free" | "local";
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
  /** Kept in step with Drive folders (Settings → Sync). */
  synced?: boolean;
  /** When sync last wrote a newer version from Drive into this save (ms; the page reloads it, see saves.ts). */
  syncAt?: number;
}

/** A trip shared through Drive: which trip it is wherever it's copied, who shared it, and whether others may change it.
 *  Kept in the trip itself, so it goes along to every folder and computer. */
export interface TripShare {
  id: string;
  /** The Google account that shared it (only they can change `mode`). */
  owner: string;
  ownerName?: string;
  mode: "edit" | "view";
}

/** A sync folder in Drive (Settings → Sync). */
export interface SyncFolder {
  /** A Google Drive folder's id, "dropbox:id:…" for a Dropbox folder, or "local:<path>" for a folder on this computer (or a network drive, or a folder a cloud
   *  app like OneDrive keeps in step here). */
  id: string;
  /** The name it has in this app ("Friends"). */
  label: string;
  /** Its name in Drive. */
  name: string;
  /** The account may add and change files in it (otherwise trips there can only be opened). */
  canWrite: boolean;
  /** Also look for trip files in the folders directly inside it (one folder per trip). Off unless ticked. */
  discover?: boolean;
  /** For a folder on this computer: what carries it elsewhere ("OneDrive", "Network drive"…, or "Only on this computer"). */
  kind?: string;
  error?: string;
}

/** How a saved trip syncs, for Your trips. */
export interface TripSyncInfo {
  folders: string[];
  /** By sync folder: the folder inside it that the trip's file is in (none for one at its top). */
  inside: Record<string, string>;
  /** Sync folders that hold this trip's file without it syncing there (offered again in its sync panel). */
  found: string[];
  share: TripShare | null;
  /** The signed-in account shared it (or it isn't shared yet). */
  mine: boolean;
  /** Changes made here are synced (it's yours, or shared as "can edit"). */
  canEdit: boolean;
  /** Changed here and in Drive since the last sync: the person picks which to keep. */
  conflicts: { folder: string; by: string; at: string }[];
  /** The trip's file went into another folder inside a sync folder, which more people may open: paused until the person
   *  says. at: that folder's id ("" the sync folder's top), where: its name. */
  moved?: { folder: string; at: string; where: string }[];
  error?: string;
}

/** Where in a sync folder with a folder per trip a newly added trip goes: onto the copy already there, into a folder
 *  inside it, into a new one (limit: Drive's limited access), or at its top. Always the person's choice. */
export type SyncPlace = { file: string } | { sub: string } | { create: string; limit: boolean } | { top: true };
/** The choices for one such folder. */
export interface SyncPlaces {
  /** The account may add to the top folder (and so make folders there). */
  topWrite: boolean;
  /** limited: Drive only. trips: the trip files already in it. */
  folders: { id: string; name: string; canWrite: boolean; limited?: boolean; /** Seen, but this account can't open it. */ noAccess?: boolean; trips: string[] }[];
  /** Copies of this trip already there ("" sub: at the top); with any, one of them has to be chosen. */
  matches: { fileId: string; name: string; sub: string; subId: string }[];
}

/** What someone may do in a Drive folder. "fileOrganizer" (content manager) and "organizer" (manager) are shared drives'. */
export type AccessRole = "reader" | "commenter" | "writer" | "fileOrganizer" | "organizer";
/** One person, group, organisation or "anyone with the link" on a Drive folder. */
export interface AccessEntry {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: AccessRole | "owner";
  name: string;
  email: string;
  domain: string;
  /** The signed-in account. */
  me: boolean;
  /** Only comes from a folder further up (or the shared drive): changed there. */
  inherited: boolean;
  /** On a folder with limited access: they have it above, but here only see that the folder exists. */
  shutOut: boolean;
  /** When it ends, if Google set an end. */
  until?: string;
}
/** Who has access to a Drive folder, and what this account may do about it. */
export interface FolderAccess {
  id: string;
  name: string;
  canManage: boolean;
  sharedDrive: boolean;
  driveRoot: boolean;
  /** Limited access: access from the folders above doesn't open this one. */
  limited: boolean;
  /** This account may turn that on or off. */
  canLimit: boolean;
  /** The roles that can be given here. */
  roles: AccessRole[];
  /** null: this account isn't told who else has access. */
  people: AccessEntry[] | null;
}

export interface SyncStatus {
  /** A Google client ID and secret are set up (Settings → Sync; see docs/google-sync.md). */
  configured: boolean;
  /** Where they come from (entered in the app, or environment variables), and the ID. The secret isn't sent. */
  clientFrom: "app" | "env" | "";
  clientId: string;
  signedIn: boolean;
  email: string;
  name: string;
  /** Google signed this computer out (the access was removed in the Google account): sign in again. */
  expired?: boolean;
  /** What the sign-in allows: Drive (sync and photos), and read-only Cloud access (Gemini's exact limits). */
  drive?: boolean;
  cloud?: boolean;
  signingIn: boolean;
  signInError: string;
  folders: SyncFolder[];
  /** By save name. */
  trips: Record<string, TripSyncInfo>;
  running: boolean;
  lastRun: number;
  error: string;
  /** Dropbox: an app key set up (Settings → Sync), and whether signed in. */
  dropbox: { configured: boolean; keyFrom: "app" | "env" | ""; signedIn: boolean; expired: boolean; email: string; name: string; signingIn: boolean; signInError: string };
  /** Who this is (the Google account, this computer's user): trips shared by any of these are this person's. */
  identities: string[];
  /** The same as they're stamped on the parts of a trip someone changed (shared/edits.ts): to tell one's own changes. */
  editIds: string[];
  /** Profile pictures from Drive and Dropbox, by the same stamps' id. */
  pictures?: Record<string, string>;
  /** Things the person should know about (a trip removed from a folder in Drive, so it stopped syncing there). */
  notices: string[];
}

/** A trip in a sync folder that isn't on this computer yet. */
export interface RemoteTripCard extends TripCard {
  /** The folder inside the sync folder it's in, if it's not at its top. */
  inner?: string;
  folder: string;
  fileId: string;
  by: string;
  share: TripShare | null;
}

/** A saved trip as a card in Your trips (GET /api/trips). */
export interface TripCard {
  name: string;
  savedAt: string;
  /** The plan's own name for the trip ("Alpine road trip"), if there's a plan. */
  title: string;
  cities: string[];
  /** First day and last day (YYYY-MM-DD), "" when the stays have no dates. */
  start: string;
  end: string;
  nights: number;
  travelers: number;
  /** Days in the plan (0: no plan yet). */
  days: number;
  cost: number;
  currency: string;
  countries: { cc: string; country: string }[];
  /** The stays in order, [lat, lng] (those that were looked up). */
  route: [number, number][];
  /** Some of the plan's stops, for texture. */
  dots: [number, number][];
  /** Some stays are still being looked up: the route isn't complete yet. */
  locating?: boolean;
  bookings: number;
  mustSees: number;
}

/** A freely licensed picture of a place, from Wikimedia (POST /api/place-pictures). */
export interface PlacePicture {
  /** The picture, 1280 px wide. */
  url: string;
  /** Its own page, with the full licence. */
  page: string;
  /** The article it illustrates. */
  title: string;
  author: string;
  licence: string;
}

/** One change in the update log: its headline, an introduction, and its points, grouped under small headings where there
 *  are some. */
export interface Change { subject: string; intro: string; groups: { head: string; points: string[] }[] }
/** One version in the update log (Settings → Updates); made from the commit messages by scripts/changelog.mjs. */
export interface Release { version: string; date: string; changes: Change[] }
