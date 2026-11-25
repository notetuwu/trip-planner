// Where a photo without a GPS position probably was taken. Best: where their other photos with a position were taken just
// before or after it (a phone's photos usually have one; a camera's often don't). Otherwise the trip's own plan: the
// photo's date picks the day, its time of day the stop they were at, or the nearer of the two stops it falls between
// (never a point on a straight line between them, which lands in places they never went). A guess, so the map shows it
// as one.

/** One day of the plan for the guess: its stops with a place on the map and a time, and where they slept. */
export interface DayStops { date: string; stops: { min: number; lat: number; lng: number; name: string }[]; home?: { lat: number; lng: number; name: string } }
export interface Spot { lat: number; lng: number; near: string }
/** A photo with a position and a time, to place others by. */
export interface Anchor { t: string; lat: number; lng: number }

/** Close enough in time to count as being at a stop (minutes). */
const AT = 40;
/** A photo with a position taken at most this long before or after (minutes) says where one without was taken. */
const NEAR_PHOTO = 45;

/** "2027-09-14T10:30:05" → the day's date and the minutes since midnight (null without a time of day). */
function split(t: string): { date: string; min: number | null } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(t);
  return m ? { date: m[1], min: m[2] ? +m[2] * 60 + +m[3] : null } : { date: "", min: null };
}

/** Minutes since 2000 of "2027-09-14T10:30:05" (the camera's own clock, compared as written), NaN without a time. */
const minutes = (t: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(t);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : NaN;
};

/** Photos with a position, sorted by time, to look up quickly. */
export function anchorsOf(photos: { t: string; lat?: number; lng?: number }[]): { at: number; lat: number; lng: number }[] {
  return photos.filter((p) => p.lat != null && p.lng != null && p.t).map((p) => ({ at: minutes(p.t), lat: p.lat!, lng: p.lng! }))
    .filter((a) => Number.isFinite(a.at)).sort((a, b) => a.at - b.at);
}

/** Where the photo with a position taken closest in time to `t` was, if it's within NEAR_PHOTO minutes. */
function nearestPhoto(t: string, anchors: { at: number; lat: number; lng: number }[]): Spot | null {
  const at = minutes(t);
  if (!Number.isFinite(at) || !anchors.length) return null;
  let lo = 0, hi = anchors.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (anchors[mid].at < at) lo = mid + 1; else hi = mid; }
  const best = [anchors[lo - 1], anchors[lo]].filter(Boolean).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
  if (!best || Math.abs(best.at - at) > NEAR_PHOTO) return null;
  const mins = Math.round(Math.abs(best.at - at));
  return { lat: best.lat, lng: best.lng, near: mins < 1 ? "where your other photos from then were taken" : `where you took a photo ${mins} min ${best.at < at ? "before" : "after"}` };
}

/** The most likely spot for a photo taken at `t` (the camera's own clock, "2027-09-14T10:30:05"): by their photos with a
 *  position taken around then, else by the plan; null when neither covers it. */
export function spotByTime(t: string, days: DayStops[], anchors: { at: number; lat: number; lng: number }[] = []): Spot | null {
  const byPhoto = nearestPhoto(t, anchors);
  if (byPhoto) return byPhoto;
  const { date, min } = split(t);
  const day = date ? days.find((d) => d.date === date) : undefined;
  if (!day) return null;
  const stops = day.stops.filter((s) => Number.isFinite(s.min)).sort((a, b) => a.min - b.min);
  const home = day.home ? { lat: day.home.lat, lng: day.home.lng, near: day.home.name } : null;
  const at = (s: { lat: number; lng: number; name: string }): Spot => ({ lat: s.lat, lng: s.lng, near: s.name });
  if (!stops.length) return home;
  // No time of day: the day's first stop is as good a guess as any.
  if (min == null) return at(stops[0]);
  const prev = [...stops].reverse().find((s) => s.min <= min), next = stops.find((s) => s.min > min);
  if (!prev) return next && (next.min - min <= 90 || !home) ? at(next) : home || at(stops[0]);
  if (!next) return min - prev.min <= 180 || !home ? at(prev) : home;
  const gap = next.min - prev.min;
  if (min - prev.min <= AT || gap <= AT) return at(prev);
  if (next.min - min <= AT) return at(next);
  // Between two stops, far from both: the one nearer in time (they were at one of them or on the way, not in the fields
  // a straight line between them crosses).
  return min - prev.min <= next.min - min ? at(prev) : at(next);
}

/** A spot given to a photo by hand (Photos window → Place on map), or "can't place". Kept with the trip; the photo's
 *  file is never changed. */
export type PhotoSpot = { lat: number; lng: number } | { skip: true };

/** What a photo's hand-given spot is kept under: a Drive file's id is the same everywhere; a file on a computer is
 *  named by its folder's name and its path in it (so the same folder on another computer matches, and the same file name
 *  in two folders doesn't). */
export function spotKey(folder: string, id: string) {
  if (!/^local:/i.test(folder)) return id;
  const name = folder.slice(6).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  return `local:${name}/${id}`;
}

/** The photo with its hand-given spot applied: `placed` (it overrides the camera's position too), or `skipped` (no
 *  position, and none is guessed). `camera`: the file itself has a position. A spot that isn't a sensible position (a
 *  trip file edited by hand) is ignored. */
export function withSpot<T extends { lat?: number; lng?: number }>(p: T, spot: PhotoSpot | undefined): T & { camera: boolean; placed?: boolean; skipped?: boolean } {
  const camera = p.lat != null && p.lng != null;
  if (spot && "skip" in spot && spot.skip) return { ...p, lat: undefined, lng: undefined, camera, skipped: true };
  if (spot && "lat" in spot && Number.isFinite(spot.lat) && Number.isFinite(spot.lng) && Math.abs(spot.lat) <= 90 && Math.abs(spot.lng) <= 180) return { ...p, lat: spot.lat, lng: spot.lng, camera, placed: true };
  return { ...p, camera };
}

/** Photos taken in one go: sorted by time, a new group after a pause longer than `gap` minutes or on another day. Those
 *  with no time are one group, last. */
export function burstsOf<T extends { t: string }>(photos: T[], gap = 10): T[][] {
  const timed = photos.filter((p) => p.t).sort((a, b) => a.t.localeCompare(b.t)), rest = photos.filter((p) => !p.t);
  const out: T[][] = [];
  let last = NaN, day = "";
  for (const p of timed) {
    const at = minutes(p.t), d = p.t.slice(0, 10);
    // (A date without a clock time, NaN, groups by its day.)
    if (!out.length || d !== day || at - last > gap) out.push([]);
    out[out.length - 1].push(p);
    last = at; day = d;
  }
  if (rest.length) out.push(rest);
  return out;
}
