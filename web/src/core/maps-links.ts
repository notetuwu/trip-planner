// Links into a maps app: Google Maps, Apple Maps or Bing Maps (Settings → General → Map). Every place link,
// directions link and "restaurants around here" search goes through these, so they all open in the chosen app.
import { prefs } from "./prefs";

export { genericMeal } from "../geo/stop-text";

export type MapsApp = "google" | "apple" | "bing";
export type TravelMode = "driving" | "walking" | "transit" | "bicycling";
interface At { lat: number; lng: number }

export const mapsApp = (): MapsApp => prefs.app.mapsApp || "google";
export const mapsName = (app = mapsApp()) => ({ google: "Google Maps", apple: "Apple Maps", bing: "Bing Maps" })[app];

/** A point written for a route: coordinates as they are, anything else as text. */
const isCoords = (s: string) => /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(s.trim());

/** A search for a place by name (around a point, where one is known: the right town's "Café Central"). */
export function searchUrl(query: string, near?: At | null, app = mapsApp()) {
  if (app === "apple") return `https://maps.apple.com/?${new URLSearchParams({ q: query, ...(near ? { sll: `${near.lat.toFixed(5)},${near.lng.toFixed(5)}` } : {}) })}`;
  if (app === "bing") return `https://www.bing.com/maps?${new URLSearchParams({ q: query, ...(near ? { cp: `${near.lat.toFixed(5)}~${near.lng.toFixed(5)}`, lvl: "14" } : {}) })}`;
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query })}`;
}

/** A pin at a point, labelled. */
export function pointUrl(at: At, label = "", app = mapsApp()) {
  const ll = `${at.lat.toFixed(6)},${at.lng.toFixed(6)}`;
  if (app === "apple") return `https://maps.apple.com/?${new URLSearchParams({ ll, q: label || ll })}`;
  if (app === "bing") return `https://www.bing.com/maps?${new URLSearchParams({ cp: `${at.lat.toFixed(6)}~${at.lng.toFixed(6)}`, lvl: "16", sp: `point.${at.lat.toFixed(6)}_${at.lng.toFixed(6)}_${label || "Place"}` })}`;
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: ll })}`;
}

/** A saved place in the maps app. Places keep the Google Maps link they came with (from the list, or made when picked
 *  on the map): that's used with Google; with another app, the place's spot, else a search for its name and address. */
export function placeUrl(p: { title: string; url?: string; address?: string; lat?: number; lng?: number }, app = mapsApp()) {
  if (p.url && (app === "google" || !/google\.|goo\.gl/.test(p.url))) return p.url;
  const at = typeof p.lat === "number" && typeof p.lng === "number" ? { lat: p.lat, lng: p.lng } : null;
  // Its name and address find the place itself; the bare point only when there's no address to go by.
  if (at && !p.address) return pointUrl(at, p.title, app);
  return searchUrl([p.title, p.address].filter(Boolean).join(", "), at, app);
}

/** Directions from one place to another ("lat,lng" or a name with its town). */
export function directionsLink(from: string, to: string, mode: TravelMode, app = mapsApp()) {
  if (app === "apple") {
    const flag = mode === "walking" ? "w" : mode === "transit" ? "r" : mode === "bicycling" ? "c" : "d";
    return `https://maps.apple.com/?${new URLSearchParams({ saddr: from, daddr: to, dirflg: flag })}`;
  }
  if (app === "bing") {
    const end = (s: string) => (isCoords(s) ? `pos.${s.replace(/\s/g, "").replace(",", "_")}` : `adr.${s}`);
    const m = mode === "walking" ? "w" : mode === "transit" ? "t" : "d";
    return `https://www.bing.com/maps?${new URLSearchParams({ rtp: `${end(from)}~${end(to)}`, mode: m })}`;
  }
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", origin: from, destination: to, travelmode: mode })}`;
}

