// Travel days: the day you move from one stay to the next. The drive (or ride) between the two stays is one line in
// the mode the travelers picked, passing through the day's stops that lie on the way; the day's own long legs aren't
// drawn again on top of it.
import type { Day, ItineraryItem, LatLng } from "../../../shared/types";
import { state } from "../core/state";
import { type ByTitle, itemLoc } from "../geo/item-loc";
import { distKm, stayLoc } from "../geo/locate";
import { chosenMode, modeOf, transferEnds } from "../trip/modes";
import { type JourneyRun, journeyRuns, namesRide } from "../itinerary/journey-model";

/** Movements ("Lucerne → Feldkirch", "Drive to the hotel") aren't places to pin. */
export const isTransfer = (x: ItineraryItem) => x.kind === "transfer" || !!transferEnds(x);
/** On the map as a point: every stop, and a transfer ("Rigi Kulm → Vitznau") once they've set where it ends (then it's
 *  a point the way goes through, like the foot of the mountain). */
export const onMap = (x: ItineraryItem) => !isTransfer(x) || !!x.pinned;

/** The stay a day arrives at (index > 0), when the day is a travel day. */
export function arrivalStay(d: Day): number {
  return state.stays.findIndex((s, i) => i > 0 && s.start && s.start === d.date);
}

/** A travel day's journey: the stay it arrives at, and the runs of its stops that are the journey (see journey-model). */
export function journeyOf(d: Day): { arrive: number; runs: JourneyRun[] } | null {
  const arrive = arrivalStay(d);
  return arrive > 0 ? { arrive, runs: journeyRuns(d.items, (x) => isTransfer(x) || namesRide(x)) } : null;
}

/** Whether the map draws the travel day's own journey (its rides, leg by leg) instead of the stays' line between the two
 *  towns: when the day spells out its rides and they say more than that line does. A drive between the stays is one
 *  road route through the stops on the way, so a day of the same driving keeps it; by public transport, or with a ride
 *  of another kind (the taxi up to the hotel after the train), the day's own rides are the way. */
export function ownsJourney(d: Day) {
  const j = journeyOf(d);
  if (!j?.runs.length) return false;
  const stay = state.stays[j.arrive].travel || "";
  if (stay !== "car" && stay !== "bike") return true;
  return j.runs.some((r) => r.items.some((i) => { const m = chosenMode(d.items[i]) || modeOf(d.items[i]); return !!m && m !== stay; }));
}

/** Whether the travel day into stay i spells out its own journey. */
export function stayLegOwned(i: number) {
  const d = state.itinerary?.days.find((x) => x.date === state.stays[i]?.start);
  return !!d && ownsJourney(d);
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
