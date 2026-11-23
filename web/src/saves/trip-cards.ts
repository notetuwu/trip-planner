// Your trips, the pure part: when a trip is (coming up, now, past, no dates) and how that reads ("In 3 weeks",
// "Day 4 of 12", "2 years ago"), filtering, sorting and grouping by year, and the rough route sketch on each card.
// No page or settings in here, so the tests can use it.
import type { TripCard } from "../../../shared/types";

export type When = "upcoming" | "now" | "past" | "undated";
export type Filter = "all" | When;
export type Sort = "recent" | "date-desc" | "date-asc" | "name" | "length";

const dayMs = 864e5;
const days = (a: string, b: string) => Math.round((+new Date(`${b}T00:00:00Z`) - +new Date(`${a}T00:00:00Z`)) / dayMs);

export function whenOf(c: TripCard, today: string): When {
  if (!c.start) return "undated";
  if (c.start > today) return "upcoming";
  return (c.end || c.start) >= today ? "now" : "past";
}

/** How far away it is, in words: "Tomorrow", "In 5 days", "In 3 weeks", "In 4 months"; "Day 4 of 12"; "Last week",
 *  "3 months ago", "2 years ago". */
export function whenLabel(c: TripCard, today: string): string {
  const w = whenOf(c, today);
  if (w === "undated") return "No dates yet";
  if (w === "now") return `Day ${days(c.start, today) + 1} of ${days(c.start, c.end || c.start) + 1}`;
  const n = w === "upcoming" ? days(today, c.start) : days(c.end || c.start, today);
  const unit = (v: number, one: string) => `${v} ${one}${v === 1 ? "" : "s"}`;
  const span = n < 14 ? unit(n, "day") : n < 60 ? unit(Math.round(n / 7), "week") : n < 548 ? unit(Math.round(n / 30.4), "month") : unit(Math.round(n / 365), "year");
  if (w === "upcoming") return n === 1 ? "Tomorrow" : `In ${span}`;
  return n === 1 ? "Yesterday" : n < 14 && n >= 7 ? "Last week" : `${span} ago`;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Search by name, title, towns and countries; then the filter and the order. */
export function pickTrips(cards: TripCard[], o: { query: string; filter: Filter; sort: Sort; today: string }): TripCard[] {
  const words = norm(o.query).split(/\s+/).filter(Boolean);
  const hay = (c: TripCard) => norm([c.name, c.title, ...c.cities, ...c.countries.map((x) => `${x.country} ${x.cc}`), c.start.slice(0, 4)].join(" "));
  const shown = cards.filter((c) => (o.filter === "all" || whenOf(c, o.today) === o.filter) && words.every((w) => hay(c).includes(w)));
  const undatedLast = (a: TripCard, b: TripCard) => (a.start ? 0 : 1) - (b.start ? 0 : 1);
  const by: Record<Sort, (a: TripCard, b: TripCard) => number> = {
    recent: (a, b) => b.savedAt.localeCompare(a.savedAt),
    "date-desc": (a, b) => undatedLast(a, b) || b.start.localeCompare(a.start),
    "date-asc": (a, b) => undatedLast(a, b) || a.start.localeCompare(b.start),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    length: (a, b) => b.nights - a.nights || a.name.localeCompare(b.name),
  };
  return [...shown].sort(by[o.sort]);
}

/** Groups for the date orders: coming up, happening now, then each past year (a memory lane), then no dates. */
export function groupTrips(cards: TripCard[], sort: Sort, today: string): { label: string; cards: TripCard[] }[] {
  if (sort !== "date-desc" && sort !== "date-asc") return [{ label: "", cards }];
  const groups = new Map<string, TripCard[]>();
  for (const c of cards) {
    const w = whenOf(c, today);
    const label = w === "upcoming" ? "Coming up" : w === "now" ? "Happening now" : w === "undated" ? "No dates yet" : c.start.slice(0, 4);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(c);
  }
  return [...groups.entries()].map(([label, cs]) => ({ label, cards: cs }));
}

/** A colour per trip (from its name), so cards are told apart at a glance. */
export function hueOf(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * The route sketch: the stays joined in order (the line draws itself in), the plan's stops as faint dots, the start
 * marked; fitted into w×h with the map's proportions (longitude narrowed by latitude). Nothing located: a dashed globe.
 */
export function previewSvg(c: TripCard, w = 320, h = 168, pad = 22): string {
  const pts = [...c.route, ...c.dots];
  if (!pts.length) {
    return `<svg class="tc-svg empty" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <circle cx="${w / 2}" cy="${h / 2}" r="${h / 3.2}" class="pv-globe"/><ellipse cx="${w / 2}" cy="${h / 2}" rx="${h / 7}" ry="${h / 3.2}" class="pv-globe"/>
      <line x1="${w / 2 - h / 3.2}" y1="${h / 2}" x2="${w / 2 + h / 3.2}" y2="${h / 2}" class="pv-globe"/></svg>`;
  }
  const lat0 = pts.reduce((n, p) => n + p[0], 0) / pts.length, k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[1] * k), ys = pts.map((p) => -p[0]);
  // At least ~0.6° across, so a one-town trip isn't blown up to street level.
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 0.6), spanY = Math.max(maxY - minY, 0.6);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const at = (p: [number, number]) => [w / 2 + (p[1] * k - cx) * scale, h / 2 + (-p[0] - cy) * scale].map((v) => Math.round(v * 10) / 10);
  const grid = Array.from({ length: 7 }, (_, i) => `<line x1="${(i + 1) * w / 8}" y1="0" x2="${(i + 1) * w / 8}" y2="${h}"/>`).join("")
    + Array.from({ length: 3 }, (_, i) => `<line x1="0" y1="${(i + 1) * h / 4}" x2="${w}" y2="${(i + 1) * h / 4}"/>`).join("");
  const dots = c.dots.map((p) => { const [x, y] = at(p); return `<circle cx="${x}" cy="${y}" r="1.6" class="pv-dot"/>`; }).join("");
  const route = c.route.map(at);
  // A round trip ends where it starts: don't draw that stay twice.
  const line = route.length > 1 ? `<polyline points="${route.map((p) => p.join(",")).join(" ")}" pathLength="1" class="pv-route"/>` : "";
  const stays = route.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 0 ? 5 : 3.6}" class="pv-stay${i === 0 ? " first" : ""}" style="--d:${(0.25 + (i / Math.max(1, route.length - 1)) * 0.9).toFixed(2)}s"/>`).join("");
  return `<svg class="tc-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g class="pv-grid">${grid}</g>${dots}${line}${stays}</svg>`;
}
