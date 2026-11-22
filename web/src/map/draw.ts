// Redraws everything on the map from the current trip.
import * as L from "leaflet";
import type { LatLng } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { session, state } from "../core/state";
import { byTitleMap } from "../geo/item-loc";
import { placeLoc } from "../geo/locate";
import { renderDayChips } from "./days";
import { drawDays } from "./draw-days";
import { drawStays } from "./draw-stays";
import { cssVar, itemMarkers, layers, map, placeMarkers, popupIsOpen, whenPopupCloses } from "./map";
import { placePopupHtml } from "./place-popup";
import { dayLegs, requestRoutes } from "./routes";

/** Saved places as small dots, must-sees highlighted. Places already in the itinerary are drawn as its stops. */
function drawPlaces(fitToPlaces: boolean, bounds: LatLng[]) {
  const it = state.itinerary;
  const scheduled = new Set(it ? it.days.flatMap((d) => d.items.map((x) => x.place)) : []);
  for (const p of session.places) {
    const loc = placeLoc(p); if (!loc) continue;
    if (it && scheduled.has(p.title)) continue;
    const mark = state.marks[p.title];
    const color = mark === "must" ? cssVar("--ok") : mark === "skip" ? cssVar("--skip") : cssVar("--muted");
    const m = L.circleMarker([loc.lat, loc.lng], {
      radius: mark === "must" ? 7 : 5, color: "#fff", weight: 1.5, fillColor: color,
      fillOpacity: mark === "skip" ? .35 : .9, opacity: mark === "skip" ? .4 : 1,
    }).bindTooltip(esc(p.title), { direction: "top", offset: [0, -6] })
      .bindPopup(placePopupHtml(p), { minWidth: 240, maxWidth: 340 })
      .addTo(layers.places);
    placeMarkers.set(p.title, m);
    if (fitToPlaces) bounds.push([loc.lat, loc.lng]);
  }
}

let waiting: { fit: boolean } | null = null;

export function drawMap({ fit = false } = {}) {
  if (!map) return;
  // Redrawing makes every marker anew, which would close the popup someone is reading (and new lookups or routes come
  // in all the time while a big trip loads): wait until it's closed. Actions in a popup close it first.
  if (popupIsOpen()) {
    if (!waiting) whenPopupCloses(() => { const w = waiting; waiting = null; if (w) drawMap(w); });
    waiting = { fit: fit || !!waiting?.fit };
    return;
  }
  for (const layer of Object.values(layers)) layer.clearLayers();
  placeMarkers.clear(); itemMarkers.clear();
  const it = state.itinerary, byTitle = byTitleMap();
  const bounds: LatLng[] = [];

  const stayPts = drawStays();
  if (session.selectedDay == null) bounds.push(...stayPts);
  if ($<HTMLInputElement>("#showPlaces").checked) drawPlaces(!it && session.selectedDay == null && stayPts.length === 0, bounds);
  if (it) {
    bounds.push(...drawDays(it.days, byTitle));
    requestRoutes(it.days.flatMap((d) => dayLegs(d, byTitle)));
  }

  if ((fit || !session.userMoved) && bounds.length) {
    if (fit) session.userMoved = false;
    // Extra top padding keeps pins out from under the search box.
    map.flyToBounds(L.latLngBounds(bounds), { maxZoom: 14, duration: .6, paddingTopLeft: [30, 70], paddingBottomRight: [30, 30] });
  }
  renderDayChips();
}
