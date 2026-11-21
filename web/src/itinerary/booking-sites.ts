// Where to book tickets and tours: one big platform for the whole trip rather than a different site per attraction.
// Klook is the largest in East and Southeast Asia; GetYourGuide covers Europe and most of the rest of the world.
import type { ItineraryItem } from "../../../shared/types";

export interface BookingSite { name: string; search(query: string): string }

export const KLOOK: BookingSite = { name: "Klook", search: (q) => `https://www.klook.com/search/result/?query=${encodeURIComponent(q)}` };
export const GETYOURGUIDE: BookingSite = { name: "GetYourGuide", search: (q) => `https://www.getyourguide.com/s/?q=${encodeURIComponent(q)}` };

const KLOOK_COUNTRIES = new Set(["JP", "KR", "TW", "HK", "MO", "CN", "SG", "TH", "VN", "MY", "ID", "PH", "KH", "LA", "MM", "BN"]);

/** Klook when every country of the trip is one it's strongest in; otherwise GetYourGuide, so one site covers it all. */
export function bookingSite(countryCodes: string[]): BookingSite {
  const ccs = countryCodes.map((c) => c.toUpperCase()).filter(Boolean);
  return ccs.length && ccs.every((c) => KLOOK_COUNTRIES.has(c)) ? KLOOK : GETYOURGUIDE;
}

const MEAL = /^(breakfast|brunch|lunch|dinner|coffee|drinks|snack)\b/i;

/** Tickets and tours can be booked on the platform; meals (a table) and transfers (a train) can't. */
export function bookableOnSite(x: ItineraryItem) {
  if (!x.booking) return false;
  if (x.kind) return x.kind === "sight" || x.kind === "activity" || x.kind === "other";
  return !MEAL.test(x.place) && !/→|->/.test(x.place);
}

/** The search to run on the platform: the place, plus the town when the name doesn't say it. */
export function bookingQuery(place: string, town: string) {
  const name = place.replace(/\s*\([^)]*\)/g, "").trim();
  return town && !name.toLowerCase().includes(town.toLowerCase()) ? `${name} ${town}` : name;
}
