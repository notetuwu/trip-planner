// What a fresh plan leaves out although it was asked for: a lunch or dinner, enough to do on a full day, and anything
// to do on a travel day that's over early. Small
// models skip these, so they go back to the model with the other checks. Plain data in, no page.
import type { Itinerary } from "../../../shared/types";
import { isMeal } from "./duplicates";

/** The fewest sights and activities a full day has at each pace (as the planning prompt asks). */
const FEWEST = { relaxed: 3, balanced: 4, packed: 6 };

export interface Gap { day: number; text: string }

/** The date `n` days on ("2027-09-01", 2 → "2027-09-03"). */
const later = (date: string, n: number) => new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
const hour = (t: string) => Number(/^(\d{1,2}):\d{2}/.exec(t || "")?.[1] ?? NaN);

/**
 * One entry per day that lacks something: dinner (every day but the last), and on full days (a night before and after
 * at the same stay) lunch and the pace's number of sights and activities; on other days but the last, at least one of
 * those when every transfer starts by noon.
 */
export function planGaps(it: Itinerary, stays: { start: string; nights: number }[], pace: string): Gap[] {
  const fewest = FEWEST[(Object.keys(FEWEST) as (keyof typeof FEWEST)[]).find((k) => pace.startsWith(k)) || "balanced"];
  return it.days.flatMap((d, day) => {
    const full = stays.some((s) => s.start && d.date > s.start && d.date < later(s.start, Number(s.nights) || 0));
    const meals = d.items.filter(isMeal).map((x) => hour(x.time));
    const stops = d.items.filter((x) => !isMeal(x) && x.kind !== "transfer").length;
    const missing: string[] = [];
    // A meal without a readable time may be the one asked for, so it counts.
    if (full && !meals.some((h) => Number.isNaN(h) || (h >= 11 && h < 16))) missing.push("there is no lunch");
    if (day < it.days.length - 1 && !meals.some((h) => Number.isNaN(h) || h >= 17 || h < 3)) missing.push("there is no dinner");
    if (full && stops < fewest) missing.push(`this full day has only ${stops} sight${stops === 1 ? "" : "s"} or activit${stops === 1 ? "y" : "ies"} (at least ${fewest} at their pace, unless one of them really fills the day)`);
    const transfers = d.items.filter((x) => x.kind === "transfer");
    if (!full && day < it.days.length - 1 && !stops && transfers.length && transfers.every((x) => hour(x.time) <= 12)) {
      missing.push("there is nothing to see or do although the travel starts early (add something near where they arrive or on the way, unless the travel really fills the day)");
    }
    if (!missing.length) return [];
    return [{ day, text: `Something is missing: ${missing.join("; ")}. Add it at free times with real places near where they are that day, none already in the trip, and keep the day's other stops. Leave it out only if their own requests or bookings say so.` }];
  });
}
