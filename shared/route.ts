// Where a must-see sits relative to the route: on the way between two stays, or near one of them.
import type { MustSeeRoute } from "./types";

interface Pt { lat: number; lng: number }
export interface RouteStay extends Pt { city: string; start: string; nights: number }

export function km(a: Pt, b: Pt) {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

/** Close enough to a stay to simply visit it from there. */
const NEAR_STAY_KM = 20;

/**
 * The leg (pair of consecutive stays) the place adds the least detour to, and the nearest stay you sleep at.
 * onWay: the detour is small for the leg's length and the place isn't right next to a stay anyway.
 * Distances are straight lines, so they're rough; roads only make detours a little longer.
 */
export function routeFor(p: Pt, stays: (RouteStay | null)[]): MustSeeRoute {
  let leg: MustSeeRoute["leg"], base: MustSeeRoute["base"];
  for (let i = 1; i < stays.length; i++) {
    const a = stays[i - 1], b = stays[i];
    if (!a || !b || a.city === b.city) continue;
    const ab = km(a, b);
    if (ab < 30) continue;
    const detour = km(a, p) + km(p, b) - ab;
    if (!leg || detour < leg.detourKm) leg = { from: a.city, to: b.city, date: b.start, detourKm: Math.round(detour), legKm: Math.round(ab) };
  }
  for (const s of stays) {
    if (!s || !(s.nights > 0)) continue;
    const d = km(s, p);
    if (!base || d < base.km) base = { city: s.city, km: Math.round(d) };
  }
  const onWay = !!leg && leg.detourKm <= Math.max(25, leg.legKm * 0.15) && !(base && base.km < NEAR_STAY_KM);
  return { leg, base, onWay };
}

/** What the planning prompt says about a must-see's place in the trip ("" when there's nothing to say). */
export function routeNote(r: MustSeeRoute | undefined) {
  if (!r) return "";
  const legText = r.leg ? `between ${r.leg.from} and ${r.leg.to}${r.leg.date ? ` on the travel day ${r.leg.date}` : ""} (about +${r.leg.detourKm} km detour)` : "";
  if (r.how === "way" && r.leg) return `the travelers want it as a stop on the way ${legText}, not as a day trip`;
  if (r.how === "stay") return `the travelers want to visit it from where they sleep${r.base ? ` (nearest: ${r.base.city}, ${r.base.km} km away)` : ""}, not as a stop on a travel day; if it's far, as a day trip on a full day`;
  if (r.onWay) return `lies on the way ${legText}: make it a stop on that travel day rather than a separate day trip`;
  return "";
}
