// Map-side types shared by the server and the browser app: geocoding, routes and real places.

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
  /** OpenStreetMap opening_hours, e.g. "Tu-Su 09:00-17:00". */
  hours?: string;
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
  status: "ok" | "closed" | "opens-later" | "closes-early" | "closed-all-day" | "unknown";
  text: string;
}

