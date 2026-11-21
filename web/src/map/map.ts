// The Leaflet map: tiles, layers, and the click-to-add behaviour.
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
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

export function initMap() {
  map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([30, 10], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
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
