// Transport between stays and on day trips, and helpers for reading itinerary stops.
import type { ItineraryItem, TravelMode } from "../../../shared/types";
import { state } from "../core/state";

/** "" lets the planner choose. */
export const TRAVEL_MODES: [TravelMode, string][] = [["", "Planner decides"], ["car", "🚗 Car"], ["train", "🚆 Train"], ["bus", "🚌 Bus"], ["flight", "✈️ Flight"], ["ferry", "⛴ Ferry"], ["bike", "🚲 Bike"]];
const label = (m: TravelMode | undefined) => (m ? TRAVEL_MODES.find(([k]) => k === m)?.[1] || "" : "");
export const modeName = (m?: TravelMode) => label(m).replace(/^\S+\s/, "").toLowerCase();
export const modeIcon = (m?: TravelMode) => label(m).split(" ")[0];
export const modeOptions = (sel?: TravelMode) =>
  TRAVEL_MODES.map(([k, text]) => `<option value="${k}"${(sel || "") === k ? " selected" : ""}>${text}</option>`).join("");

/** "Salzburg → Hallstatt" style transfers. */
export const ARROW = /\s*(?:→|->|⇒|–>)\s*/;
/** A stop's name without bracketed details. */
export const cleanStop = (s: string) => String(s).replace(/\s*\([^)]*\)/g, "").trim();
/** [from, to] of a transfer, or null for a normal stop. */
export const transferEnds = (x: ItineraryItem) => {
  const ends = cleanStop(x.place).split(ARROW).filter(Boolean);
  return ends.length === 2 ? (ends as [string, string]) : null;
};

const normCity = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(",")[0].trim();
const sameCity = (x: string, y: string) => { const a = normCity(x), b = normCity(y); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };

/** The mode the travelers picked for a transfer ("Padua → Milan") or a day trip ("Milan → Rome", "Rome → Milan"). */
export function chosenMode(x: ItineraryItem): TravelMode {
  const ends = transferEnds(x);
  if (!ends) return "";
  const [a, b] = ends;
  for (let i = 1; i < state.stays.length; i++) {
    const s = state.stays[i];
    if (s.travel && sameCity(a, state.stays[i - 1].city) && sameCity(b, s.city)) return s.travel;
  }
  for (const s of state.stays) for (const t of s.dayTrips || []) {
    if (t.mode && t.place && ((sameCity(a, s.city) && sameCity(b, t.place)) || (sameCity(a, t.place) && sameCity(b, s.city)))) return t.mode;
  }
  return "";
}

/** A stop's subgroup while the travelers are split up, or "" when everyone is together. Some models label shared
 *  stops "All" or give a group with everyone in it; that isn't a split. */
export const splitGroup = (x: ItineraryItem) => {
  const g = String(x.group || "").trim();
  if (!g || /^(all|everyone|everybody|together|whole group|both|group)$/i.test(g)) return "";
  if (x.people && x.people >= (state.travelers || 1) && (state.travelers || 1) > 1) return "";
  return g;
};
