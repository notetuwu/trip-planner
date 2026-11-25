// The walking parts of a public transport leg (no page code here, so it can be tested).
import type { LatLng } from "../../../shared/types";

/** The parts of a leg's line that aren't one of its rides: the walks to the first stop, between rides and from the
 *  last one (the line and the rides come from the same answer, so each ride's ends are points of the line, near enough). */
export function walksOf(line: LatLng[], rides: LatLng[][]): LatLng[][] {
  const d2 = (a: LatLng, b: LatLng) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const nearest = (p: LatLng) => line.reduce((best, q, k) => (d2(q, p) < d2(line[best], p) ? k : best), 0);
  const spans = rides.map((c) => [nearest(c[0]), nearest(c[c.length - 1])].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  const out: LatLng[][] = [];
  let from = 0;
  for (const [a, b] of spans) {
    if (a > from) out.push(line.slice(from, a + 1));
    from = Math.max(from, b);
  }
  if (from < line.length - 1) out.push(line.slice(from));
  return out.filter((p) => p.length > 1);
}
