// The Leaflet map: tiles, layers, and the click-to-add behaviour.
import * as L from "leaflet";
import { linesSettingChanged } from "./transit-lines";
import { gridSettingChanged } from "./lines-grid";
import { onAppPrefs, prefs } from "../core/prefs";
import { $, toast } from "../core/dom";
import { session } from "../core/state";
import { openAddPopup } from "./add";
import { drawMap } from "./draw";
import { wirePlacePopup } from "./place-popup";
import { initTransitLines } from "./transit-lines";
import { type Labels, initLayerPicker } from "./layer-picker";
import { initLinesDownload, resyncLines } from "./lines-download";
import { initLinesGrid } from "./lines-grid";
import { initPhotos } from "./photos";
import { openPhotosView } from "../itinerary/photos-view";
import { closeMapSearch } from "./search";

export let map: L.Map | null = null;
export const layers = {
  places: L.layerGroup(), stays: L.layerGroup(), routes: L.layerGroup(), items: L.layerGroup(),
};
/** Saved-place dots by title, and itinerary pins by "day-item". */
export const placeMarkers = new Map<string, L.CircleMarker>();
/** A popup is open on the map (a redraw would close it: markers are drawn anew). */
let popupOpen = false;
export const popupIsOpen = () => popupOpen;
const afterPopup: (() => void)[] = [];
/** Runs `fn` once the open popup closes (right away if none is open). */
export function whenPopupCloses(fn: () => void) { if (popupOpen) afterPopup.push(fn); else fn(); }
export const itemMarkers = new Map<string, L.Marker>();

/** The map's place names: OpenStreetMap's own map, labelled in the local language and script, or OpenFreeMap's map
 *  with English names (loaded only when picked). */
const LABELS_KEY = "trip-planner-map-labels";
let base: L.Layer | null = null, wanted: Labels = "local";

/** Picks the place names and remembers the choice in this browser (not in the trip). */
function chooseLabels(labels: Labels) {
  localStorage.setItem(LABELS_KEY, labels);
  setLabels(labels);
}

async function setLabels(labels: Labels) {
  if (!map) return;
  wanted = labels;
  let next: L.Layer;
  try {
    next = labels === "english"
    ? (await import("./english-map")).englishLayer((why) => { toast(why); if (wanted === "english") setLabels("local"); })
    // As deep as the English map: OSM's tiles end at 19, further in they're enlarged.
    : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxNativeZoom: 19, maxZoom: 22, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
  } catch (e) {
    // (Back to the local names, and the reason why.)
    toast((e as Error).message);
    if (labels === "english") return setLabels("local");
    return;
  }
  if (wanted !== labels) return; // picked something else while loading
  base?.remove();
  base = next.addTo(map);
}

export function initMap() {
  map = L.map("map", { zoomControl: true, worldCopyJump: true, maxZoom: 22 }).setView([30, 10], 2);
  // The stops of the plan's rides (where to get on, with the line): over the lines and photos, under the day's pins.
  map.createPane("rideStops").style.zIndex = "430";
  // Place names: as last picked in this browser, else as set in Settings; picking them in Settings applies at once.
  const saved = localStorage.getItem(LABELS_KEY);
  setLabels(saved === "english" || saved === "local" ? saved : prefs.app.mapNames);
  let setting = prefs.app.mapNames;
  onAppPrefs(() => { if (prefs.app.mapNames !== setting) chooseLabels(setting = prefs.app.mapNames); });
  // Keep auto-fitting to new pins until the user moves the map themselves.
  for (const ev of ["pointerdown", "wheel"]) $("#map").addEventListener(ev, () => { session.userMoved = true; }, { passive: true });
  for (const layer of Object.values(layers)) layer.addTo(map);
  // Clicking empty map adds that spot; a click that merely closes an open popup doesn't.
  let popupClosedAt = 0;
  map.on("popupopen", () => { popupOpen = true; });
  map.on("popupclose", () => {
    popupClosedAt = Date.now(); popupOpen = false;
    // Redraws that waited for the popup (see drawMap) happen now.
    for (const fn of afterPopup.splice(0)) setTimeout(fn);
  });
  map.on("click", (e) => {
    if (closeMapSearch()) return;
    if (picking) { const done = picking; endPick(); done(e.latlng); return; }
    if (Date.now() - popupClosedAt > 300) openAddPopup(e.latlng);
  });
  L.DomEvent.disableClickPropagation($("#mapSearch"));
  L.DomEvent.disableScrollPropagation($("#mapSearch"));
  map.on("popupopen", (e) => wirePlacePopup(e.popup.getElement()!));
  // Places and routes start as set in Settings → General (the boxes change them until the next start).
  $<HTMLInputElement>("#showPlaces").checked = prefs.app.showPlaces;
  $<HTMLInputElement>("#showRoutes").checked = prefs.app.showRoutes;
  $<HTMLInputElement>("#showPlaces").onchange = () => drawMap();
  $<HTMLInputElement>("#showRoutes").onchange = () => drawMap();
  initTransitLines(map);
  initLinesGrid(map);
  initPhotos(map);
  $("#photosBtn").onclick = () => openPhotosView();
  // The Layers button (bottom left): map style and transport lines.
  initLayerPicker(map, { get: () => wanted, set: chooseLabels });
  // The trip's areas' lines, downloaded ahead in the background (Settings → General → Map); asked again when that changes.
  initLinesDownload(map);
  onAppPrefs(() => { resyncLines(); linesSettingChanged(); gridSettingChanged(); });
}

/** Waiting for a click on the map that picks a spot (for a booking, say) instead of adding one. */
let picking: ((at: L.LatLng) => void) | null = null;
function endPick() {
  picking = null;
  document.getElementById("mapPick")?.remove();
  map?.getContainer().classList.remove("picking");
}

/** Stops waiting for a click on the map (the panel that asked for it closed); with `only`, just when that's what it's
 *  waiting for (not a newer ask). */
export const stopPicking = (only?: (at: L.LatLng) => void) => { if (!only || picking === only) endPick(); };

/** Asks for a spot on the map: the next click there is handed to `done` (Esc or Cancel gives up). The map scrolls into
 *  view first (on a phone it's above the sidebar), unless `scroll` is false (it's offered next to a search). */
export function pickOnMap(what: string, done: (at: L.LatLng) => void, { scroll = true } = {}) {
  if (!map) return;
  endPick();
  picking = done;
  map.closePopup();
  map.getContainer().classList.add("picking");
  const bar = document.createElement("div");
  bar.id = "mapPick";
  bar.className = "map-pick";
  bar.innerHTML = `<span>Click the spot on the map for <b></b></span><button type="button" class="btn">Cancel</button>`;
  bar.querySelector("b")!.textContent = what;
  bar.querySelector("button")!.onclick = endPick;
  $(".map-wrap").append(bar);
  L.DomEvent.disableClickPropagation(bar);
  if (scroll) $(".map-wrap").scrollIntoView({ block: "nearest", behavior: "smooth" });
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { endPick(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);
}

/** A CSS variable's current value (colours follow light/dark mode). */
export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
