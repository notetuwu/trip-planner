// Travel days: the day you move from one stay to the next. The drive (or ride) between the two stays is one line in
// the mode the travelers picked, passing through the day's stops that lie on the way; the day's own long legs aren't
// drawn again on top of it.
import type { Day, ItineraryItem, LatLng } from "../../../shared/types";
import { state } from "../core/state";
import { type ByTitle, itemLoc } from "../geo/item-loc";
import { distKm, stayLoc } from "../geo/locate";
import { transferEnds } from "../trip/modes";

/** Movements ("Lucerne → Feldkirch", "Drive to the hotel") aren't places to pin. */
export const isTransfer = (x: ItineraryItem) => x.kind === "transfer" || !!transferEnds(x);
/** On the map as a point: every stop, and a transfer ("Rigi Kulm → Vitznau") once they've set where it ends (then it's
 *  a point the way goes through, like the foot of the mountain). */
export const onMap = (x: ItineraryItem) => !isTransfer(x) || !!x.pinned;

/** The stay a day arrives at (index > 0), when the day is a travel day. */
export function arrivalStay(d: Day): number {
  return state.stays.findIndex((s, i) => i > 0 && s.start && s.start === d.date);
}

/** Legs longer than this on a travel day are part of the drive between the stays. */
export const DRIVE_KM = 12;

export interface ViaStop { xi: number; name: string; loc: LatLng }

/** The stops of the travel day into stay i that lie on the way from stay i-1 (not in either town), in plan order. */
export function viaStops(i: number, byTitle: ByTitle): ViaStop[] {
  const a = i > 0 ? stayLoc(state.stays[i - 1]) : null, b = stayLoc(state.stays[i]);
  const d = state.itinerary?.days.find((x) => x.date === state.stays[i].start);
  if (!a || !b || !d) return [];
  const ab = distKm(a, b);
  const out: ViaStop[] = [];
  d.items.forEach((x, xi) => {
    if (isTransfer(x)) return;
    const loc = itemLoc(x, d, byTitle);
    if (!loc || loc.elsewhere) return;
    const fromA = distKm(a, loc), toB = distKm(loc, b);
    // Away from both towns, and not a wild detour (a day trip in disguise would bend the drive out of shape).
    if (fromA > DRIVE_KM && toB > DRIVE_KM && fromA + toB - ab <= Math.max(40, ab * 0.6)) out.push({ xi, name: x.place, loc: [loc.lat, loc.lng] });
  });
  return out;
}
