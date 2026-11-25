// The Leaflet map: tiles, layers, and the click-to-add behaviour.
import * as L from "leaflet";
import { linesSettingChanged } from "./transit-lines";
import { gridSettingChanged } from "./lines-grid";
import { onAppPrefs, prefs } from "../core/prefs";
import { $ } from "../core/dom";
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

async function setLabels(labels: Labels) {
  if (!map) return;
  wanted = labels;
  localStorage.setItem(LABELS_KEY, labels);
  const next = labels === "english"
    ? (await import("./english-map")).englishLayer()
    : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
  if (wanted !== labels) return; // picked something else while loading
  base?.remove();
  base = next.addTo(map);
}

export function initMap() {
  map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([30, 10], 2);
  // The stops of the plan's rides (where to get on, with the line): over the lines and photos, under the day's pins.
  map.createPane("rideStops").style.zIndex = "430";
  // Place names start as set in Settings → General; the map's layer panel changes them until the next start.
  const saved: Labels = prefs.app.mapNames === "english" ? "english" : "local";
  setLabels(saved);
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
    if (!$("#mapResults").hidden) { $("#mapResults").hidden = true; return; }
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
  initLayerPicker(map, { get: () => wanted, set: (l) => { setLabels(l); } });
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

/** Asks for a spot on the map: the next click there is handed to `done` (Esc or Cancel gives up). The map scrolls into
 *  view first (on a phone it's above the sidebar). */
export function pickOnMap(what: string, done: (at: L.LatLng) => void) {
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
  $(".map-wrap").scrollIntoView({ block: "nearest", behavior: "smooth" });
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { endPick(); document.removeEventListener("keydown", esc); } };
  document.addEventListener("keydown", esc);
}

/** A CSS variable's current value (colours follow light/dark mode). */
export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
