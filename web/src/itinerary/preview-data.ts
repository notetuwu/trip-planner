// What the trip preview shows: which of their own photos belong to which stop, and which pictures stand for the whole
// trip. (No page code here, so it can be tested.)

export interface StopSpot { key: string; lat: number; lng: number }
export interface DaySpots { date: string; stops: StopSpot[] }
export interface Own<P> { byStop: Map<string, P[]>; /** By day: photos taken that day away from all its stops. */ extra: Map<string, P[]> }

/** How close (km) a photo must be to a stop to be one of it. */
const NEAR = 0.3;

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

/** Sorts the photos to the plan: one taken on a day of the trip goes to that day's nearest stop (or to the day itself
 *  when it's near none); one with no date to the nearest stop of any day. Photos from other dates aren't of this trip. */
export function ownPhotos<P extends { t: string; lat?: number; lng?: number }>(photos: P[], days: DaySpots[]): Own<P> {
  const byStop = new Map<string, P[]>(), extra = new Map<string, P[]>();
  const add = (m: Map<string, P[]>, k: string, p: P) => { m.set(k, [...(m.get(k) || []), p]); };
  for (const p of photos) {
    const date = p.t.slice(0, 10), day = date ? days.find((d) => d.date === date) : undefined;
    if (date && !day) continue;
    let best: StopSpot | null = null, dist = NEAR;
    if (p.lat != null && p.lng != null) {
      for (const s of day ? day.stops : days.flatMap((d) => d.stops)) {
        const k = km({ lat: p.lat, lng: p.lng }, s);
        if (k <= dist && (!best || k < dist)) { best = s; dist = k; }
      }
    }
    if (best) add(byStop, best.key, p);
    else if (day) add(extra, day.date, p);
  }
  return { byStop, extra };
}

/** Up to `n` pictures that stand for the trip: the must-sees first, and from as many of the towns as possible. */
export function highlights<T extends { town: string; must?: boolean; src: string }>(all: T[], n: number): T[] {
  const seen = new Set<string>(), unique = all.filter((x) => !seen.has(x.src) && !!seen.add(x.src));
  const towns = new Map<string, T[]>();
  for (const x of [...unique].sort((a, b) => Number(!!b.must) - Number(!!a.must))) towns.set(x.town, [...(towns.get(x.town) || []), x]);
  const out: T[] = [];
  for (let round = 0; out.length < Math.min(n, unique.length); round++) {
    for (const list of towns.values()) if (list[round] && out.length < n) out.push(list[round]);
  }
  return out;
}
