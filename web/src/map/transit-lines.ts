// The map's transport line overlays, like a transit map: bus, tram, metro, train, boat and cable car lines from
// OpenStreetMap, each switched on by itself (in the map's layer panel), in each line's own colour where it has one, with
// its name on hover. Shown from street level up (zoomed out, a country's lines would be too many to draw or fetch). The
// server fetches them by area and keeps them; this asks for the areas in view.
import * as L from "leaflet";
import { prefs } from "../core/prefs";
import { api, esc } from "../core/dom";
import { type IconName, icon } from "../core/icons";
import { initLineCard, openStop } from "./line-card";

export type LineKind = "bus" | "tram" | "metro" | "train" | "boat" | "lift";
export interface Line { k: LineKind; n: string; c?: string; w: number[]; r?: number[] }
interface Cell { l: Line[]; w: Record<number, [number, number][][]>; s?: [number, number, string, number[]][] }

/** Grid cell size in degrees (the server's cells), and the zoom the lines show from: a whole city at once (around 50
 *  cells), not a whole country. */
export const CELL = 0.05;
export const MIN_ZOOM = 11;
const MAX_CELLS = 160;
/** Each kind: its name, icon, colour for lines without their own, and line width (rail heavier than buses). */
export const LINE_KINDS: { k: LineKind; name: string; ic: IconName; colour: string; weight: number }[] = [
  { k: "bus", name: "Bus", ic: "bus", colour: "#2b7bd6", weight: 2.5 },
  { k: "tram", name: "Tram", ic: "tram", colour: "#c2185b", weight: 3 },
  { k: "metro", name: "Metro", ic: "train", colour: "#7b1fa2", weight: 4 },
  { k: "train", name: "Train", ic: "train", colour: "#4e5560", weight: 3.5 },
  { k: "boat", name: "Boat", ic: "ship", colour: "#0288d1", weight: 3 },
  { k: "lift", name: "Cable car", ic: "cableCar", colour: "#e65100", weight: 3 },
];
const STORE = "trip-planner-lines";

let on = new Set<LineKind>(), m: L.Map | null = null, layer: L.LayerGroup, renderer: L.Renderer;
const cells = new Map<string, Cell>();
let retry: number | undefined, pending = 0;
const listeners = new Set<() => void>();
const changed = () => { for (const f of listeners) f(); };

/** Switched on in Settings → Map (off by default). */
export const linesEnabled = () => !!prefs.app.transitLines;
/** The kinds shown: those switched on in the Layers panel, while the lines are enabled at all. */
const shownKinds = () => (linesEnabled() ? on : new Set<LineKind>());
export const isLineOn = (k: LineKind) => shownKinds().has(k);
/** Calls `f` when kinds are switched or the loading state changes. */
export const onLinesChange = (f: () => void) => { listeners.add(f); };
/** For the panel's note: areas still loading, and whether it's zoomed out too far for any lines to show. */
export const linesState = () => ({ on: shownKinds().size, pending, far: shownKinds().size > 0 && !!m && m.getZoom() < MIN_ZOOM });

/** Settings changed (the lines switched on or off): drawn and asked for again. */
export function linesSettingChanged() { draw(); load(); changed(); }

export function setLineOn(k: LineKind, yes: boolean) {
  if (yes) on.add(k); else on.delete(k);
  localStorage.setItem(STORE, JSON.stringify([...on]));
  draw(); load(); changed();
}

/** Every cell in a map's view ("<row>_<col>"), the one in the middle of the screen first and outwards from there. */
export function cellsInView(map: L.Map): string[] {
  const b = map.getBounds(), mid = map.getCenter(), out: { id: string; d: number }[] = [];
  for (let r = Math.floor(b.getSouth() / CELL); r <= Math.floor(b.getNorth() / CELL); r++)
    for (let c = Math.floor(b.getWest() / CELL); c <= Math.floor(b.getEast() / CELL); c++)
      out.push({ id: `${r}_${c}`, d: Math.hypot((r + .5) * CELL - mid.lat, ((c + .5) * CELL - mid.lng) * Math.cos((mid.lat * Math.PI) / 180)) });
  return out.sort((a, b2) => a.d - b2.d).map((x) => x.id);
}

/** The cells to show lines in, or none when zoomed out too far. */
function viewCells(): string[] {
  if (!m || m.getZoom() < MIN_ZOOM) return [];
  const out = cellsInView(m);
  return out.length > MAX_CELLS ? [] : out;
}

let asked = "";
/** Asks for the cells in view not here yet (middle first); the server fetches them before anything else,
 *  so this asks again meanwhile. Nothing to ask any more (lines off, zoomed out, panned away): it says so, so the server
 *  stops fetching the old view. */
async function load() {
  clearTimeout(retry);
  // Also, at street level, cells from before stops were added: the server fetches them again with their stops.
  const needStops = !!m && m.getZoom() >= STOPS_ZOOM;
  const want = shownKinds().size ? viewCells().filter((id) => !cells.has(id) || (needStops && !cells.get(id)!.s)) : [];
  if (!want.length) {
    if (asked) { asked = ""; api("/api/lines?cells=").catch(() => {}); }
    if (pending) { pending = 0; changed(); }
    return;
  }
  asked = want.join(",");
  try {
    const got = await api<{ cells: Record<string, Cell>; pending: number }>(`/api/lines?cells=${want.join(",")}`);
    for (const [id, cell] of Object.entries(got.cells)) cells.set(id, cell);
    if (Object.keys(got.cells).length) draw();
    if (got.pending !== pending) { pending = got.pending; changed(); }
    if (got.pending) retry = window.setTimeout(load, 4000);
    else if (needStops && Object.values(got.cells).some((c) => !c.s)) retry = window.setTimeout(load, 20000);
  } catch { retry = window.setTimeout(load, 10000); }
}

/** Strong, distinct colours for lines OpenStreetMap gives none: each line keeps the same one (picked by its number). */
const PALETTE = ["#e53935", "#1e88e5", "#43a047", "#fb8c00", "#8e24aa", "#00897b", "#d81b60", "#3949ab", "#7cb342", "#f4511e", "#00acc1", "#6d4c41", "#c0ca33", "#5e35b1"];
export function lineColour(line: Line, kind: LineKind) {
  if (line.c) return line.c;
  // Trains and boats without a colour keep their kind's (a railway is a railway); town lines get one each.
  if (kind === "train" || kind === "boat" || kind === "lift") return LINE_KINDS.find((k) => k.k === kind)!.colour;
  const key = (line.n.split(" · ")[0] || line.n).toLowerCase();
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Draws the switched-on kinds in the cells in view: trains first, buses on top. */
function draw() {
  layer.clearLayers();
  if (!shownKinds().size) return;
  const ids = viewCells();
  for (const kind of LINE_KINDS) {
    if (!on.has(kind.k)) continue;
    for (const id of ids) {
      const cell = cells.get(id);
      if (!cell) continue;
      for (const line of cell.l) {
        if (line.k !== kind.k) continue;
        const pts = line.w.flatMap((w) => cell.w[w] || []);
        if (!pts.length) continue;
        const colour = lineColour(line, kind.k);
        const [ref, rest] = line.n.includes(" · ") ? line.n.split(" · ", 2) : /^\S{1,5}$/.test(line.n) ? [line.n, ""] : ["", line.n];
        // Like a transit map's line badge: the number on the line's colour, then where it goes.
        const tip = `${icon(kind.ic)} ${ref ? `<span class="line-chip" style="--c:${colour}">${esc(ref)}</span>` : ""} ${esc(rest || (ref ? "" : kind.name))}`;
        const pl = L.polyline(pts, { renderer, color: colour, weight: kind.weight, opacity: .85, lineCap: "round", bubblingMouseEvents: false })
          .bindTooltip(tip, { sticky: true, className: "leg-tip" })
          .on("mouseover", () => pl.setStyle({ weight: kind.weight + 2.5, opacity: 1 }))
          .on("mouseout", () => pl.setStyle({ weight: kind.weight, opacity: .8 }));
        pl.addTo(layer);
      }
    }
  }
  drawStops(ids);
}

/** Stops show from street level (further out there'd be hundreds), with the icon of the most notable kind calling there. */
const STOPS_ZOOM = 15;
const STOP_RANK: LineKind[] = ["metro", "train", "tram", "lift", "boat", "bus"];
function drawStops(ids: string[]) {
  if (!m || m.getZoom() < STOPS_ZOOM) return;
  for (const id of ids) {
    const cell = cells.get(id);
    for (const [lat, lng, name, idx] of cell?.s || []) {
      const lines = idx.map((i) => cell!.l[i]).filter((l) => l && on.has(l.k));
      if (!lines.length) continue;
      const kind = LINE_KINDS.find((k) => k.k === STOP_RANK.find((r) => lines.some((l) => l.k === r)))!;
      const refs = [...new Set(lines.map((l) => (l.n.includes(" · ") ? l.n.split(" · ")[0] : l.n)).filter(Boolean))];
      L.marker([lat, lng], {
        pane: "lineStops", keyboard: false, bubblingMouseEvents: false,
        icon: L.divIcon({ className: "", html: `<div class="stop-pin" style="--c:${kind.colour}">${icon(kind.ic)}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
      }).bindTooltip(`<b>${esc(name || kind.name)}</b>${refs.length ? `<br>${refs.slice(0, 12).map((r) => esc(r)).join(" · ")}${refs.length > 12 ? " …" : ""}` : ""}`, { direction: "top", offset: [0, -10], className: "leg-tip" })
        .on("click", () => openStop(name, [lat, lng], lines.map((l) => ({ line: l, colour: lineColour(l, l.k) }))))
        .addTo(layer);
    }
  }
}

/** Sets up the overlays on the map (called once the map exists). */
export function initTransitLines(map: L.Map) {
  m = map;
  try { on = new Set(JSON.parse(localStorage.getItem(STORE) || "[]")); } catch { /* none */ }
  // Under the day's own routes and pins, over the map; the stops just above the lines.
  map.createPane("lines").style.zIndex = "350";
  map.createPane("lineStops").style.zIndex = "390";
  renderer = L.canvas({ pane: "lines", padding: 0.3 });
  layer = L.layerGroup().addTo(map);
  initLineCard(map);
  map.on("moveend", () => { draw(); load(); changed(); });
  draw(); load();
}
