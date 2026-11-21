// Geocoding through the server (Nominatim with a disk cache). Results trickle in at about one per second,
// so queries are batched and polled until they're all answered.
import type { GeoHit, GeoQuery, LatLng } from "../../../shared/types";
import { api } from "../core/dom";
import { state } from "../core/state";
import { setMapStatus } from "../map/status";

/** Results by geoKey; null means "looked up, not found". */
export const geo: Record<string, GeoHit | null> = {};

/** Must match the server's key: the "near" point (rounded to ~10 km) is only part of it when given. */
export const geoKey = (q: string, cc?: string, near?: LatLng | null) =>
  `${String(q).trim().toLowerCase()}|${cc || ""}${near ? `|${(+near[0]).toFixed(1)},${(+near[1]).toFixed(1)}` : ""}`;

const wanted = new Map<string, GeoQuery>();
let timer: number | undefined;
const listeners: (() => void)[] = [];

/** Called (debounced) whenever new coordinates arrive. */
export const onGeocoded = (fn: () => void) => { listeners.push(fn); };

export function geocode(queries: GeoQuery[]) {
  for (const x of queries) if (x.q && !(geoKey(x.q, x.cc, x.near) in geo)) wanted.set(geoKey(x.q, x.cc, x.near), x);
  clearTimeout(timer);
  timer = window.setTimeout(poll, 300);
}

let notify: number | undefined;
async function poll() {
  if (!wanted.size) return setMapStatus("");
  try {
    const { results, pending } = await api<{ results: Record<string, GeoHit | null>; pending: number }>("/api/geocode", {
      method: "POST", body: JSON.stringify({ queries: [...wanted.values()] }),
    });
    Object.assign(geo, results);
    for (const k of Object.keys(results)) wanted.delete(k);
    setMapStatus(pending ? `Locating ${pending} place${pending > 1 ? "s" : ""}…` : "");
    clearTimeout(notify);
    notify = window.setTimeout(() => listeners.forEach((fn) => fn()), 300);
    if (pending) timer = window.setTimeout(poll, 2500);
  } catch { setMapStatus("Can't reach the server for geocoding"); }
}

/** Each stay's city, hotel and day trips. */
export function geocodeStays() {
  const qs: GeoQuery[] = [];
  for (const s of state.stays) {
    if (!s.city) continue;
    qs.push({ q: s.city, first: true });
    const cc = geo[geoKey(s.city)]?.cc;
    if (s.hotel && geoKey(s.city) in geo) qs.push({ q: `${s.hotel}, ${s.city}`, cc, first: true });
    for (const t of s.dayTrips || []) if (t.place) qs.push({ q: t.place, first: true });
  }
  geocode(qs);
}
