// A line's stops in order, from what the area downloads already hold: the line's shape (its ways, cut into pieces per
// area) and the stops it calls at. The pieces are joined into one path and the stops sorted by how far along it they
// are. Instant, but only as far as the downloaded areas reach, and a guess where a line splits or loops (OpenStreetMap's
// own list replaces it when that arrives). No page code here, so it can be tested.

type Pt = [number, number];
export interface LocalStop { name: string; lat: number; lng: number }

function metres(a: Pt, b: Pt) {
  const r = Math.PI / 180, x = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
}

/** The pieces joined into one path: the longest first, then at either end whichever piece starts or ends nearest
 *  (turned round as needed). A piece running along what's already there (the other direction of a road) is left out. */
export function joinPieces(pieces: Pt[][]): Pt[] {
  const len = (p: Pt[]) => p.reduce((s, q, i) => (i ? s + metres(p[i - 1], q) : 0), 0);
  const left = pieces.filter((p) => p.length > 1).sort((a, b) => len(b) - len(a));
  if (!left.length) return [];
  let path = [...left.shift()!];
  const near = (q: Pt, d: number) => path.some((x) => metres(x, q) < d);
  for (;;) {
    let best: { i: number; at: "start" | "end"; flip: boolean; gap: number } | null = null;
    left.forEach((p, i) => {
      const ends: [Pt, "start" | "end", boolean][] = [[p[0], "end", false], [p.at(-1)!, "end", true], [p.at(-1)!, "start", false], [p[0], "start", true]];
      for (const [q, at, flip] of ends) {
        const gap = metres(q, at === "end" ? path.at(-1)! : path[0]);
        if (!best || gap < best.gap) best = { i, at, flip, gap };
      }
    });
    if (!best) break;
    const { i, at, flip, gap } = best as { i: number; at: "start" | "end"; flip: boolean; gap: number };
    const p = left.splice(i, 1)[0];
    // Too far from the path to belong to it (another branch, an area not downloaded in between).
    if (gap > 3000) continue;
    // The other direction of the same road, or a bit already covered.
    if (near(p[Math.floor(p.length / 2)], 40)) continue;
    const piece = flip ? [...p].reverse() : p;
    path = at === "end" ? [...path, ...piece] : [...piece, ...path];
  }
  return path;
}

/** The stops sorted along the path (each where it's nearest to it); stops far from it come last, in their order. */
export function orderStops(stops: LocalStop[], pieces: Pt[][]): LocalStop[] {
  const path = joinPieces(pieces);
  if (path.length < 2) return stops;
  const along: number[] = [0];
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + metres(path[i - 1], path[i]));
  const placed = stops.map((s, k) => {
    let best = Infinity, at = 0;
    path.forEach((q, i) => { const d = metres(q, [s.lat, s.lng]); if (d < best) { best = d; at = along[i]; } });
    return { s, at: best < 400 ? at : Infinity, k };
  });
  return placed.sort((a, b) => a.at - b.at || a.k - b.k).map((x) => x.s);
}
