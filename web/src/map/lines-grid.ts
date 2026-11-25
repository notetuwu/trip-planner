// The map's area grid (Layers panel → "Show download areas"): the cells the transport lines are fetched in, outlined,
// with their state: downloaded (tinted green), being fetched right now (orange, moving outline), waiting (dashed
// yellow), failed (dashed red, tried again later). Areas nobody asked for are just the grid.
import * as L from "leaflet";
import { api, esc } from "../core/dom";
import { CELL, cellsInView, linesEnabled } from "./transit-lines";
import { cancelDownload } from "./lines-download";

const STORE = "trip-planner-lines-grid", MIN_ZOOM = 9, MAX_CELLS = 700;
let on = localStorage.getItem(STORE) === "1", m: L.Map | null = null, layer: L.LayerGroup, renderer: L.Renderer, timer: number | undefined;
let state: { done: string[]; now: string[]; waiting: string[]; failed: string[]; jobs?: { cells: string[]; server: string; secs: number }[] } | null = null;
const listeners = new Set<() => void>();

export const isGridOn = () => on;
/** For the panel: the grid's counts in view, or why it shows nothing. */
export const gridState = () => ({ on, far: !!m && m.getZoom() < MIN_ZOOM, ...(state ? { done: state.done.length, waiting: state.waiting.length + state.now.length } : {}) });
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
  const ids = on && linesEnabled() && m.getZoom() >= MIN_ZOOM ? cellsInView(m) : [];
  if (!ids.length || ids.length > MAX_CELLS) { layer.clearLayers(); state = null; for (const f of listeners) f(); return; }
  try {
    state = await api("/api/lines/status", { method: "POST", body: JSON.stringify({ cells: ids }) });
  } catch { timer = window.setTimeout(refresh, 10000); return; }
  draw(ids);
  for (const f of listeners) f();
  // While something is coming, often (to see it move); otherwise now and then.
  timer = window.setTimeout(refresh, state!.now.length ? 1000 : state!.waiting.length ? 3000 : 15000);
}

function draw(ids: string[]) {
  layer.clearLayers();
  if (!state) return;
  const done = new Set(state.done), waiting = new Set(state.waiting), failed = new Set(state.failed);
  const base: L.PathOptions = { renderer, interactive: false, weight: .7, color: "#7a7a7a", opacity: .55, fill: false };
  for (const id of ids) {
    const style: L.PathOptions = state.now.includes(id) ? { ...base, weight: 2.5, color: "#ef6c00", opacity: 1, fill: true, fillColor: "#ef6c00", fillOpacity: .14, dashArray: "8 5", className: "lines-cell-now" }
      : done.has(id) ? { ...base, color: "#2e7d32", opacity: .7, fill: true, fillColor: "#43a047", fillOpacity: .14 }
      : waiting.has(id) ? { ...base, weight: 1.3, color: "#f9a825", opacity: .95, dashArray: "4 4", fill: true, fillColor: "#fdd835", fillOpacity: .06 }
      : failed.has(id) ? { ...base, weight: 1.3, color: "#c62828", opacity: .9, dashArray: "2 3" }
      : base;
    L.rectangle(bounds(id), style).addTo(layer);
  }
  // Each download's block: which server it's on and for how long.
  for (const job of state.jobs || []) {
    const rows = job.cells.map((id) => +id.split("_")[0]), cols = job.cells.map((id) => +id.split("_")[1]);
    const at: L.LatLngExpression = [((Math.min(...rows) + Math.max(...rows) + 1) / 2) * CELL, ((Math.min(...cols) + Math.max(...cols) + 1) / 2) * CELL];
    const t = job.secs >= 60 ? `${Math.floor(job.secs / 60)}:${String(job.secs % 60).padStart(2, "0")}` : `${job.secs} s`;
    L.marker(at, { pane: "linesJobs", keyboard: false, bubblingMouseEvents: false, title: "Cancel this download",
      icon: L.divIcon({ className: "", html: `<div class="lines-job">${esc(serverName(job.server))} · ${t}<b>×</b></div>`, iconSize: [0, 0] }) })
      .on("click", async () => { await cancelDownload(job.cells); refresh(); }).addTo(layer);
  }
}

/** A server as people know it: the Swiss one, the main one, or the one it moved on to. */
const serverName = (host: string) => (!host ? "starting" : /osm\.ch/.test(host) ? "Swiss server" : /overpass-api\.de/.test(host) ? "Main server" : host.replace(/^overpass\./, ""));

/** Settings changed (the lines switched on or off). */
export const gridSettingChanged = () => refresh();

/** Sets up the grid (called once the map exists). */
export function initLinesGrid(map: L.Map) {
  m = map;
  // Over the lines, under the day's routes and pins; drawn as shapes so the "fetching now" outline can move.
  map.createPane("linesGrid").style.zIndex = "360";
  // The downloads' labels (with their ×) over the lines, so they can be clicked.
  map.createPane("linesJobs").style.zIndex = "450";
  renderer = L.svg({ pane: "linesGrid", padding: 0.2 });
  layer = L.layerGroup().addTo(map);
  map.on("moveend", () => refresh());
  refresh();
}
