// Places planned on more than one day of a stay ("Case Mazzanti" on day 12 when day 9 has "Loggia di Frà Giocondo & Case
// Mazzanti"). Plain data in, no page: used by the Fix bar, the notes under the stops and the trip chat.
import type { Itinerary } from "../../../shared/types";

export type Stop = [day: number, stop: number];
/** A later copy of a place with its first one; `key` is the name they share as matched ("case mazzanti"). */
export interface Duplicate { first: Stop; again: Stop; key: string }

export const cleanStop = (s: string) => String(s).replace(/\s*\([^)]*\)/g, "").trim();
export const isMeal = (x: { kind?: string; place: string }) => x.kind === "meal" || /^(breakfast|brunch|lunch|dinner)\b/i.test(x.place);
/** A place's name for spotting repeats: no accents, case, brackets or punctuation. */
export const key = (s: string) => cleanStop(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** "Loggia di Frà Giocondo & Case Mazzanti" is two places: each part counts, so "Case Mazzanti" alone repeats it. */
const parts = (place: string) => cleanStop(place).split(/\s+(?:&|\+|and|und|e|et)\s+|\s*\/\s*/i).map(key).filter(Boolean);
/** The same place, or one name inside the other ("Arena" in "Arena di Verona") when the shorter has two words or more. */
const sameSight = (a: string, b: string) => {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.includes(" ") && ` ${l} `.includes(` ${s} `);
};

/** What of a stay matters here. */
export interface StayDates { city: string; start: string; nights: number | string }

const daysAfter = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

/** The town of the stay each stop of a day belongs to. On a travel day, what comes before the first ride is still the
 *  stay they leave, everything after it the one they go to. "" without stay dates. */
function townsOf(d: Itinerary["days"][number], stays: readonly StayDates[]): string[] {
  const on = stays.filter((s) => s.start && d.date >= s.start && daysAfter(s.start, d.date) <= (Number(s.nights) || 0)).map((s) => key(s.city.split(",")[0]));
  const ride = d.items.findIndex((x) => x.kind === "transfer" || /→|->/.test(x.place));
  return d.items.map((_, i) => (ride >= 0 && i < ride ? on[0] : on.at(-1)) || "");
}

/**
 * Places planned on more than one day in the same town they stay in (two towns can each have their "Waterfront walk";
 * a second stay in a town counts as the same one): each later copy with the first one. Sights and activities (not lodging, stations,
 * transfers or bookings the travelers entered), and named restaurants or cafés (not "Lunch" or the hotel's breakfast).
 */
export function findDuplicates(it: Itinerary, ok: ReadonlySet<string> = new Set(), stays: readonly StayDates[] = []): Duplicate[] {
  const seen: { k: string; meal: boolean; town: string; at: Stop }[] = [], out: Duplicate[] = [];
  it.days.forEach((d, di) => { const towns = townsOf(d, stays); d.items.forEach((x, xi) => {
    const town = towns[xi];
    const meal = isMeal(x);
    if (x.kind === "transfer" || /already booked/i.test(x.description || "")) return;
    if (meal ? /^(breakfast|brunch|lunch|dinner)\b/i.test(cleanStop(x.place)) || /hotel/i.test(x.place)
      : /check[- ]?(in|out)|hotel|hostel|station|airport|stazione|bahnhof|→/i.test(x.place)) return;
    // Restaurants by their exact name ("Pizzeria Da Mario" isn't "Da Mario Gelato"); sights also by their parts.
    const ks = [...new Set(meal ? [key(x.place)] : [key(x.place), ...parts(x.place)])].filter(Boolean);
    if (!ks.length) return;
    // A place the travelers marked fine to repeat isn't a duplicate (`match` is the shorter of the two names as matched).
    let match: string | undefined;
    const hit = seen.find((o) => o.meal === meal && o.town === town && o.at[0] !== di && ks.some((k) => (meal ? k === o.k : sameSight(k, o.k)) && (match = k.length <= o.k.length ? k : o.k)));
    if (hit && !ok.has(match!)) out.push({ first: hit.at, again: [di, xi], key: match! });
    else if (!hit) for (const k of ks) seen.push({ k, meal, town, at: [di, xi] });
  }); });
  return out;
}
