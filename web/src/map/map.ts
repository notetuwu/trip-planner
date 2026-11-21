// The Leaflet map: tiles, layers, and the click-to-add behaviour.
import * as L from "leaflet";
import { $ } from "../core/dom";
import { session } from "../core/state";
import { openAddPopup } from "./add";
import { drawMap } from "./draw";
import { wirePlacePopup } from "./place-popup";

export let map: L.Map | null = null;
export const layers = {
  places: L.layerGroup(), stays: L.layerGroup(), routes: L.layerGroup(), items: L.layerGroup(),
};
/** Saved-place dots by title, and itinerary pins by "day-item". */
export const placeMarkers = new Map<string, L.CircleMarker>();
export const itemMarkers = new Map<string, L.Marker>();

/** Map styles: OpenStreetMap labels places in the local language and script; Esri's street map adds English or
 *  romanized names (大阪市 Osaka-Shi), much like Google Maps. */
const TILES = {
  local: () => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }),
  english: () => L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, OpenStreetMap contributors and the GIS community',
  }),
};
type Labels = keyof typeof TILES;
const LABELS_KEY = "trip-planner-map-labels";
let tiles: L.TileLayer | null = null;

function setLabels(labels: Labels) {
  if (!map) return;
  tiles?.remove();
  tiles = TILES[labels]().addTo(map);
  localStorage.setItem(LABELS_KEY, labels);
}

export function initMap() {
  map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([30, 10], 2);
  const saved = localStorage.getItem(LABELS_KEY) === "english" ? "english" : "local";
  setLabels(saved);
  const pick = $<HTMLSelectElement>("#mapLabels");
  pick.value = saved;
  pick.onchange = () => setLabels(pick.value as Labels);
  // Keep auto-fitting to new pins until the user moves the map themselves.
  for (const ev of ["pointerdown", "wheel"]) $("#map").addEventListener(ev, () => { session.userMoved = true; }, { passive: true });
  for (const layer of Object.values(layers)) layer.addTo(map);
  // Clicking empty map adds that spot; a click that merely closes an open popup doesn't.
  let popupClosedAt = 0;
  map.on("popupclose", () => { popupClosedAt = Date.now(); });
  map.on("click", (e) => {
    if (!$("#mapResults").hidden) { $("#mapResults").hidden = true; return; }
    if (Date.now() - popupClosedAt > 300) openAddPopup(e.latlng);
  });
  L.DomEvent.disableClickPropagation($("#mapSearch"));
  L.DomEvent.disableScrollPropagation($("#mapSearch"));
  map.on("popupopen", (e) => wirePlacePopup(e.popup.getElement()!));
  $<HTMLInputElement>("#showPlaces").onchange = () => drawMap();
  $<HTMLInputElement>("#showRoutes").onchange = () => drawMap();
}

/** A CSS variable's current value (colours follow light/dark mode). */
export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
