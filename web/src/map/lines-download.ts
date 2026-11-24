// Downloading the map's transport lines ahead, in the background (Settings → General → Map): the areas around the trip's
// stays and its day's stops, plus any area downloaded from the Layers panel ("Download this area"). The server fetches
// them slowly, one at a time and never while a plan is being made, and keeps them; this tells it which areas and shows
// how far it got.
import type * as L from "leaflet";
import { api } from "../core/dom";
import { prefs } from "../core/prefs";
import { state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { distKm, stayLoc } from "../geo/locate";
import { CELL, cellsInView } from "./transit-lines";

export interface DownloadState { total: number; ready: number; left: number; failed: number; disk: { areas: number; bytes: number } }
const AREAS = "trip-planner-lines-areas";

let last: DownloadState | null = null, lastKey = "", timer: number | undefined;
const listeners = new Set<() => void>();
export const downloadState = () => last;
export const onDownloadChange = (f: () => void) => { listeners.add(f); };
const changed = () => { for (const f of listeners) f(); };

const cellOf = (lat: number, lng: number) => `${Math.floor(lat / CELL)}_${Math.floor(lng / CELL)}`;

/** The cells within `km` of a point (each cell whose middle is within reach, plus the one it's in). */
function around(lat: number, lng: number, km: number, out: Set<string>) {
  out.add(cellOf(lat, lng));
  const dLat = km / 111, dLng = km / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  for (let r = Math.floor((lat - dLat) / CELL); r <= Math.floor((lat + dLat) / CELL); r++)
    for (let c = Math.floor((lng - dLng) / CELL); c <= Math.floor((lng + dLng) / CELL); c++)
      if (distKm({ lat, lng }, { lat: (r + .5) * CELL, lng: (c + .5) * CELL }) <= km + CELL * 55) out.add(`${r}_${c}`);
}

/** The trip's areas: around each stay, and each day's stops (with the cells next to them), plus areas downloaded by hand. */
function wanted(): string[] {
  const out = new Set<string>(), km = Number(prefs.app.linesRadius) || 10;
  for (const s of state.stays) { const l = stayLoc(s); if (l) around(l.lat, l.lng, km, out); }
  const it = state.itinerary, byTitle = byTitleMap();
  for (const d of it?.days || []) for (const x of d.items) { const l = itemLoc(x, d, byTitle); if (l && !l.elsewhere) around(l.lat, l.lng, 2, out); }
  for (const id of savedAreas()) out.add(id);
  return [...out];
}
const savedAreas = (): string[] => { try { return JSON.parse(localStorage.getItem(AREAS) || "[]"); } catch { return []; } };

/** Tells the server what to download (nothing when it's switched off) and notes how far it got. */
async function sync(force = false) {
  clearTimeout(timer);
  const cells = prefs.app.linesDownload ? wanted() : savedAreas();
  const key = cells.slice().sort().join(",");
  // Unchanged and done: nothing to ask. Otherwise ask (it answers the progress too), and again in a while. The cells in
  // view go along, so the server fetches the trip's areas you're looking at first.
  if (force || key !== lastKey || (last?.left ?? 1) > 0) {
    try {
      const first = theMap ? cellsInView(theMap).slice(0, 400) : [];
      last = await api<DownloadState>("/api/lines/prefetch", { method: "POST", body: JSON.stringify({ cells, first }) });
      lastKey = key;
      changed();
    } catch { /* the server is busy or away: next round */ }
  }
  timer = window.setTimeout(sync, (last?.left ?? 0) > 0 ? 20_000 : 60_000);
}

let theMap: L.Map | null = null, moved: number | undefined;
/** Starts the background download (a little after the page has settled); after the map moves, the areas now in view
 *  move to the front of what's left. */
export function initLinesDownload(map: L.Map) {
  theMap = map;
  window.setTimeout(() => sync(true), 8000);
  map.on("moveend", () => { clearTimeout(moved); moved = window.setTimeout(() => { if ((last?.left ?? 0) > 0) sync(true); }, 1500); });
}
/** Settings changed (on or off, the radius): ask again now. */
export const resyncLines = () => sync(true);

/** "Download this area": the cells in view, kept with the trip's areas from now on. Returns how many were added. */
export function downloadView(map: L.Map) {
  const b = map.getBounds(), add = new Set(savedAreas());
  const before = add.size;
  for (let r = Math.floor(b.getSouth() / CELL); r <= Math.floor(b.getNorth() / CELL); r++)
    for (let c = Math.floor(b.getWest() / CELL); c <= Math.floor(b.getEast() / CELL); c++) add.add(`${r}_${c}`);
  localStorage.setItem(AREAS, JSON.stringify([...add].slice(-3000)));
  sync(true);
  return add.size - before;
}
/** How many cells the view covers (the button is offered up to a city's size). */
export function viewCellCount(map: L.Map) {
  const b = map.getBounds();
  return (Math.floor(b.getNorth() / CELL) - Math.floor(b.getSouth() / CELL) + 1) * (Math.floor(b.getEast() / CELL) - Math.floor(b.getWest() / CELL) + 1);
}

/** Forgets every downloaded area (and the areas downloaded by hand); the trip's start downloading again if it's on. */
export async function clearDownloaded() {
  localStorage.removeItem(AREAS);
  await api("/api/lines", { method: "DELETE" });
  lastKey = "";
  await sync(true);
}

/** "52 of 112 areas ready · 34 MB", for Settings and the Layers panel. */
export function downloadText(s = last) {
  if (!s) return "";
  const mb = (s.disk.bytes / 1e6).toFixed(s.disk.bytes > 1e7 ? 0 : 1);
  if (!s.total) return `${s.disk.areas} area${s.disk.areas === 1 ? "" : "s"} downloaded · ${mb} MB`;
  return `${s.ready} of ${s.total} areas ready${s.left ? `, ${s.left} to go` : ""}${s.failed ? ` (${s.failed} failed, tried again later)` : ""} · ${mb} MB on disk`;
}
