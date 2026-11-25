// Map-side types shared by the server and the browser app: geocoding, routes and real places.

export interface GeoHit {
  lat: number;
  lng: number;
  name: string;
  label: string;
  country: string;
  cc: string;
  kind: string;
  /** The place's own website, when OpenStreetMap has one (asked for itinerary stops only). */
  website?: string;
  /** Its other names (local, English, German…), so "Gletschergarten" matches a hit named "Glacier garden". */
  names?: string[];
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
  /** An itinerary stop: also ask for the place's website (cached under its own key). */
  stop?: boolean;
}

export type LatLng = [number, number];

/** A routed leg: distance (m), duration (s) and the path as [lat, lng] pairs. */
export interface Route {
  d: number;
  t: number;
  c: LatLng[];
  /** Train routes: indexes in c of the first and last station, so a stay-to-stay line can end at the stations. */
  rail?: [number, number];
  /** Public transport (from Transitous): each ride of the connection, in order. Absent for roads and paths. */
  rides?: Ride[];
}

/** A stop of a ride: its name and where it is. */
export interface RideStop { n: string; lat: number; lng: number }

/** One ride of a public transport connection, as the timetable has it. */
export interface Ride {
  /** Transitous's kind: BUS, COACH, TRAM, SUBWAY, METRO, FERRY, AERIAL_LIFT, FUNICULAR, or a kind of rail. */
  mode: string;
  /** The line's number or short name ("5", "JC"), when the operator gives a real one. */
  line?: string;
  /** Its full name ("JR Chūō Rapid Line"), when given. */
  name?: string;
  /** "#019a66", when the operator gives one. */
  colour?: string;
  agency?: string;
  /** Where it's headed (the last stop of the whole trip). */
  to: string;
  /** Where they get on and off, and the stops in between. */
  on: RideStop;
  off: RideStop;
  stops: RideStop[];
  /** When it leaves, local time ("08:14"). */
  dep?: string;
  /** Its own stretch of the line, [lat, lng] (the rest of the leg is walking). */
  c?: LatLng[];
}

/** Along footpaths, roads, or the railway (a real train connection, from a public transport router). */
/** lift: gondolas, cable cars, chairlifts and funiculars; transit: trams, metros and bus lines. */
export type RouteMode = "foot" | "bike" | "car" | "train" | "ferry" | "lift" | "transit";

export interface Poi {
  name: string;
  lat: number;
  lng: number;
  city?: string;
  /** OpenStreetMap opening_hours, e.g. "Tu-Su 09:00-17:00". */
  hours?: string;
  /** The place's own website, from OpenStreetMap. */
  website?: string;
}

/** Is a stop open while it's planned? Checked against its OpenStreetMap opening hours. */
export interface HoursCheck {
  hours: string;
  date: string;
  /** "HH:MM", or "" to only check whether it opens that day. */
  time: string;
  minutes: number;
  cc?: string;
  lat: number;
  lng: number;
}

export interface HoursResult {
  /** closes-soon: closes before the next stop but leaves time for a visit (a note, not a problem). */
  status: "ok" | "closed" | "opens-later" | "closes-early" | "closes-soon" | "closed-all-day" | "unknown";
  text: string;
  /** opens-later: when it opens ("08:00"), so the stop can simply move there. */
  opens?: string;
}

