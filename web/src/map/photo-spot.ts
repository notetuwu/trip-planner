// Where a photo without a GPS position probably was taken: the trip's own plan says where they were at that time. The
// photo's date picks the day, its time of day the stop they were at (or between two stops, a point on the way). A guess,
// so the map shows it as one.

/** One day of the plan for the guess: its stops with a place on the map and a time, and where they slept. */
export interface DayStops { date: string; stops: { min: number; lat: number; lng: number; name: string }[]; home?: { lat: number; lng: number; name: string } }
export interface Spot { lat: number; lng: number; near: string }

/** Close enough in time to count as being at a stop (minutes). */
const AT = 40;

/** "2027-09-14T10:30:05" → the day's date and the minutes since midnight (null without a time of day). */
function split(t: string): { date: string; min: number | null } {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(t);
  return m ? { date: m[1], min: m[2] ? +m[2] * 60 + +m[3] : null } : { date: "", min: null };
}

/** The most likely spot for a photo taken at `t` (the camera's own clock, "2027-09-14T10:30:05"), or null when the plan
 *  doesn't cover that day. */
export function spotByTime(t: string, days: DayStops[]): Spot | null {
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
  // Between two stops, far from both: on the way, as far along as the time is.
  const f = (min - prev.min) / gap;
  return { lat: prev.lat + (next.lat - prev.lat) * f, lng: prev.lng + (next.lng - prev.lng) * f, near: `${prev.name} → ${next.name}` };
}
