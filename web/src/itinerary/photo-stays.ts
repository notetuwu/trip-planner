// Which stay of the trip a photo in the gallery belongs to, by the date it was taken: the stay slept at that night. So a
// travel day is the stay arrived at, and the day the trip ends is the last stay.

type Dated = { start?: string; nights: number | string };

/** The date a stay is left: its start plus its nights. */
const leaving = (s: Dated) => new Date(Date.parse(`${s.start}T00:00:00Z`) + Number(s.nights || 0) * 864e5).toISOString().slice(0, 10);

/** The stay's place in the list for a date ("2027-09-14"), or -1: no date, or none of the stays'. */
export function stayIndexOn(date: string, stays: Dated[]): number {
  if (!date) return -1;
  const night = stays.findIndex((s) => s.start && date >= s.start && date < leaving(s));
  if (night >= 0) return night;
  // A day with no night in the trip: the day a stay is left (the latest one, when two end then).
  return stays.findLastIndex((s) => s.start && date >= s.start && date <= leaving(s));
}
