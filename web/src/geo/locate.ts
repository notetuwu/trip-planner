// Where stays and saved places are, and which countries the trip is in.
import type { Day, GeoHit, Place } from "../../../shared/types";
import { api } from "../core/dom";
import { addDays } from "../core/format";
import { type Stay, session, state } from "../core/state";
import { geo, geoKey, geocode } from "./geocode";
import { searchUrl } from "../core/maps-links";

/** A point on the map; approx/elsewhere mark itinerary stops whose position is a guess. */
export interface Loc {
  lat: number;
  lng: number;
  approx?: boolean;
  /** The only known place of this name is far from the day, here. */
  elsewhere?: string;
  name?: string;
  label?: string;
  cc?: string;
  country?: string;
}

export function distKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

/** A stay's position: the hotel if it can be found near the city, else the city. */
export function stayLoc(s: Stay): GeoHit | null {
  const city = s.city ? geo[geoKey(s.city)] : null;
  // Put on the map by hand: exactly there (the country from the town, for links and the planner).
  if (s.pin && Number.isFinite(s.pin.lat) && Number.isFinite(s.pin.lng)) {
    return { lat: s.pin.lat, lng: s.pin.lng, name: s.hotel || s.city, label: s.pin.label, country: city?.country || "", cc: city?.cc || "", kind: "pin" };
  }
  const hotel = s.hotel ? geo[geoKey(`${s.hotel}, ${s.city}`, city?.cc)] : null;
  if (hotel && (!city || distKm(hotel, city) < 60)) return { ...hotel, country: hotel.country || city?.country || "", cc: hotel.cc || city?.cc || "" };
  return city || null;
}

/** The stay you sleep at on a given day. */
export const stayOn = (d: Day) => state.stays.find((s) => s.start && d.date >= s.start && d.date <= addDays(s.start, s.nights));

/** [code, name] of each country the stays are in. */
export const tripCountries = () => [...new Map(state.stays.map(stayLoc).filter((l): l is GeoHit => !!l?.cc).map((l) => [l.cc, l.country])).entries()];
export const countryCodes = () => tripCountries().map(([cc]) => cc).join(",");

export const placeQuery = (p: Place) => ({ q: p.address || p.title, cc: countryCodes() });

export function placeLoc(p: Place): Loc | null {
  if (p.lat != null && p.lng != null) return { lat: p.lat, lng: p.lng };
  return geo[geoKey(placeQuery(p).q, placeQuery(p).cc)] || null;
}

/** Looks up saved places without coordinates, once the countries are known (so names are searched in the right place). */
export function geocodePlaces() {
  if (!countryCodes()) return;
  geocode(session.places.filter((p) => p.lat == null).map(placeQuery));
}

let warmedFor = "";
/** Once the stays are located, have the server fetch the real places around them in the background
 *  (that can take half a minute per town), so Generate doesn't have to wait for it. */
export function warmNearby() {
  const stays = state.stays.filter((s) => s.city).map((s) => ({ city: s.city, cc: stayLoc(s)?.cc }));
  if (!stays.length || stays.some((s) => !s.cc)) return;
  const sig = JSON.stringify(stays);
  if (sig === warmedFor) return;
  warmedFor = sig;
  api("/api/nearby/warm", { method: "POST", body: JSON.stringify({ stays }) }).catch(() => {});
}

/** The maps app at a stay: its hotel when one is given, else the town. */
export const stayMapsUrl = (s: Stay) => searchUrl(s.hotel ? `${s.hotel}, ${s.city}` : s.city, stayLoc(s));

/** A place's name for comparing: lower case, without accents or a trailing ", Country" ("Burg Hohenwerfen, Austria" → "burg hohenwerfen"). */
export const sameName = (name: string) => name.split(",")[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
