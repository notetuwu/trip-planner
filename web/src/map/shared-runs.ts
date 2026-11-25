// On a split day, groups often share a stretch (the same train out of town, the walk from the hotel). Only there is a
// group's line drawn wider underneath the others, so each colour still shows; elsewhere every line keeps its width.
import type { LatLng } from "../../../shared/types";

const CELL = 0.0002; // about 20 m
const cell = (p: LatLng) => `${Math.round(p[0] / CELL)},${Math.round(p[1] / CELL)}`;

/** The cells a set of lines passes through, sampled every cell along each segment (vertices can be far apart). */
export function cellsOf(lines: LatLng[][]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      out.add(cell(line[i]));
      if (i === 0) continue;
      const [a, b] = [line[i - 1], line[i]];
      const steps = Math.min(2000, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / CELL));
      for (let s = 1; s < steps; s++) out.add(cell([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]));
    }
  }
  return out;
}

/** Whether a point lies on (within a cell or so of) the lines whose cells these are. */
function near(cells: Set<string>, p: LatLng): boolean {
  const [y, x] = [Math.round(p[0] / CELL), Math.round(p[1] / CELL)];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cells.has(`${y + dy},${x + dx}`)) return true;
  return false;
}

/** Roughly how long a line is, in km. */
function km(line: LatLng[]): number {
  let sum = 0;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    sum += Math.hypot(b[0] - a[0], (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180)) * 111.2;
  }
  return sum;
}

/** The parts of a line that run along the other lines (given by their cells), at least `minKm` long: just touching
 *  (both at the same station entrance) isn't a shared stretch. */
export function sharedRuns(line: LatLng[], others: Set<string>, minKm = 0): LatLng[][] {
  const out: LatLng[][] = [];
  let run: LatLng[] = [];
  const flush = () => { if (run.length > 1 && km(run) >= minKm) out.push(run); run = []; };
  for (const p of line) {
    if (near(others, p)) run.push(p);
    else flush();
  }
  flush();
  return out;
}
