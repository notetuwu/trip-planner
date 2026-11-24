// The map's area grid (Layers panel → "Show download areas"): the cells the transport lines are fetched in, outlined,
// with their state: downloaded (tinted green), being fetched right now (orange, moving outline), waiting (dashed
// yellow), failed (dashed red, tried again later). Areas nobody asked for are just the grid.
import * as L from "leaflet";
import { api } from "../core/dom";
import { CELL, cellsInView } from "./transit-lines";

const STORE = "trip-planner-lines-grid", MIN_ZOOM = 9, MAX_CELLS = 700;
let on = localStorage.getItem(STORE) === "1", m: L.Map | null = null, layer: L.LayerGroup, renderer: L.Renderer, timer: number | undefined;
let state: { done: string[]; now: string | null; waiting: string[]; failed: string[] } | null = null;
const listeners = new Set<() => void>();

export const isGridOn = () => on;
/** For the panel: the grid's counts in view, or why it shows nothing. */
export const gridState = () => ({ on, far: !!m && m.getZoom() < MIN_ZOOM, ...(state ? { done: state.done.length, waiting: state.waiting.length + (state.now ? 1 : 0) } : {}) });
export const onGridChange = (f: () => void) => { listeners.add(f); };

export function setGridOn(yes: boolean) {
  on = yes;
  localStorage.setItem(STORE, yes ? "1" : "");
  refresh();
}

const bounds = (id: string): L.LatLngBoundsExpression => {
  const [r, c] = id.split("_").map(Number);
  return [[r * CELL, c * CELL], [(r + 1) * CELL, (c + 1) * CELL]];
};

async function refresh() {
  clearTimeout(timer);
  if (!m) return;
  const ids = on && m.getZoom() >= MIN_ZOOM ? cellsInView(m) : [];
  if (!ids.length || ids.length > MAX_CELLS) { layer.clearLayers(); state = null; for (const f of listeners) f(); return; }
  try {
    state = await api("/api/lines/status", { method: "POST", body: JSON.stringify({ cells: ids }) });
  } catch { timer = window.setTimeout(refresh, 10000); return; }
  draw(ids);
  for (const f of listeners) f();
  // While something is coming, often (to see it move); otherwise now and then.
  timer = window.setTimeout(refresh, state!.now || state!.waiting.length ? 3000 : 15000);
}

function draw(ids: string[]) {
  layer.clearLayers();
  if (!state) return;
  const done = new Set(state.done), waiting = new Set(state.waiting), failed = new Set(state.failed);
  const base: L.PathOptions = { renderer, interactive: false, weight: .7, color: "#7a7a7a", opacity: .55, fill: false };
  for (const id of ids) {
    const style: L.PathOptions = id === state.now ? { ...base, weight: 2.5, color: "#ef6c00", opacity: 1, fill: true, fillColor: "#ef6c00", fillOpacity: .14, dashArray: "8 5", className: "lines-cell-now" }
      : done.has(id) ? { ...base, color: "#2e7d32", opacity: .7, fill: true, fillColor: "#43a047", fillOpacity: .14 }
      : waiting.has(id) ? { ...base, weight: 1.3, color: "#f9a825", opacity: .95, dashArray: "4 4", fill: true, fillColor: "#fdd835", fillOpacity: .06 }
      : failed.has(id) ? { ...base, weight: 1.3, color: "#c62828", opacity: .9, dashArray: "2 3" }
      : base;
    L.rectangle(bounds(id), style).addTo(layer);
  }
}

/** Sets up the grid (called once the map exists). */
export function initLinesGrid(map: L.Map) {
  m = map;
  // Over the lines, under the day's routes and pins; drawn as shapes so the "fetching now" outline can move.
  map.createPane("linesGrid").style.zIndex = "360";
  renderer = L.svg({ pane: "linesGrid", padding: 0.2 });
  layer = L.layerGroup().addTo(map);
  map.on("moveend", () => refresh());
  refresh();
}
