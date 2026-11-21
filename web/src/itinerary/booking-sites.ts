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

const norm = (s: string) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s*\([^)]*\)/g, "").trim();

/** A sight or activity (not a meal, transfer, hotel or other errand), and not just a town ("Venice" on a day trip). */
function isVisit(x: ItineraryItem, towns: string[]) {
  if (towns.some((t) => norm(t) === norm(x.place))) return false;
  if (x.kind) return x.kind === "sight" || x.kind === "activity";
  return !MEAL.test(x.place) && !/→|->/.test(x.place);
}

/** Worth booking ahead, so worth a search on the platform: tickets and tours it sells. */
export function bookableOnSite(x: ItineraryItem, towns: string[] = []) {
  return (x.booking === "essential" || x.booking === "recommended") && isVisit(x, towns);
}

/** Costs money to get in (even if you just pay at the door). */
export function paidEntry(x: ItineraryItem, towns: string[] = []) {
  return (!!x.booking || Number(x.cost) > 0) && isVisit(x, towns);
}

export interface TicketLink { url: string; label: string; title: string }

/** Where to get tickets for a stop: the platform for things to book ahead, else the place's own website, else a web
 *  search for its tickets (small museums and castles are rarely on the big platforms). */
export function ticketLink(x: ItineraryItem, towns: string[], site: BookingSite, website?: string): TicketLink | null {
  const q = bookingQuery(x.place, towns[0] || "");
  if (bookableOnSite(x, towns)) return { url: site.search(q), label: site.name, title: `Find tickets on ${site.name}` };
  if (!paidEntry(x, towns)) return null;
  if (website) return { url: website, label: "Tickets / info", title: "The place's own website" };
  return { url: `https://www.google.com/search?q=${encodeURIComponent(`${q} tickets`)}`, label: "Tickets", title: "Search for tickets and prices" };
}

/** The search to run on the platform: the place, plus the town when the name doesn't say it. */
export function bookingQuery(place: string, rawTown: string) {
  // Brackets hold details such as an address ("Reutlingen (Schloss 1)"), which don't belong in a search.
  const name = place.replace(/\s*\([^)]*\)/g, "").trim(), town = rawTown.replace(/\s*\([^)]*\)/g, "").trim();
  return town && !name.toLowerCase().includes(town.toLowerCase()) ? `${name} ${town}` : name;
}
