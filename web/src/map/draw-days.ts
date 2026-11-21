// The itinerary on the map: numbered stops per day, joined by their routes (each split group gets its own line).
import * as L from "leaflet";
import type { Day, LatLng } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { dayColor, fmtDate } from "../core/format";
import { session } from "../core/state";
import { type ByTitle, itemLoc } from "../geo/item-loc";
import { splitGroup } from "../trip/modes";
import { highlightItem } from "./days";
import { hoverBand, legTip } from "./legs";
import { itemMarkers, layers } from "./map";
import { dayLegs, legRoute } from "./routes";

function drawStops(d: Day, di: number, byTitle: ByTitle, bounds: LatLng[]) {
  const color = dayColor(di);
  d.items.forEach((x, xi) => {
    const loc = itemLoc(x, d, byTitle);
    if (!loc) return;
    const note = loc.elsewhere ? ` · ⚠ the known place of this name is in ${esc(loc.elsewhere)}` : loc.approx ? " · approximate location (the model's estimate)" : "";
    const m = L.marker([loc.lat, loc.lng], {
      icon: L.divIcon({ className: "", html: `<div class="num-pin${loc.approx ? " approx" : ""}" style="--c:${color}">${xi + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).bindTooltip(`${esc(x.time)} ${esc(x.place)}${note}`, { direction: "top", offset: [0, -10] })
      .bindPopup(`<b>${esc(x.place)}</b><div class="pop-meta">${esc(fmtDate(d.date))} · ${esc(x.time)}${splitGroup(x) ? ` · ${esc(x.group)}` : ""}</div><div>${esc(x.description)}</div>`)
      .on("click", () => highlightItem(di, xi))
      .addTo(layers.items);
    itemMarkers.set(`${di}-${xi}`, m);
    bounds.push([loc.lat, loc.lng]);
  });
}

function drawLegs(d: Day, di: number, byTitle: ByTitle) {
  const color = dayColor(di);
  for (const leg of dayLegs(d, byTitle)) {
    const r = legRoute(leg);
    const line = r ? r.c : [leg.from, leg.to];
    // Walking: dotted along paths; road: solid; train/tram/ferry/flight (or no route found): long dashes, straight.
    const style: L.PolylineOptions = r && leg.mode === "foot" ? { weight: 4, dashArray: "1 7" }
      : r ? { weight: 4 }
      : leg.mode === "straight" || r === null ? { weight: 3, dashArray: "8 8" }
      : { weight: 2, dashArray: "2 6", opacity: .4 }; // still being routed
    const vis = L.polyline(line, { color, opacity: .8, lineCap: "round", interactive: false, ...style }).addTo(layers.routes);
    hoverBand(line, legTip(d, leg, r), vis).on("click", () => highlightItem(di, leg.xi)).addTo(layers.routes);
  }
}

/** Draws the selected day (or all days); returns the stops' positions for fitting the map. */
export function drawDays(days: Day[], byTitle: ByTitle): LatLng[] {
  const bounds: LatLng[] = [];
  days.forEach((d, di) => {
    if (session.selectedDay != null && session.selectedDay !== di) return;
    drawStops(d, di, byTitle, bounds);
    if ($<HTMLInputElement>("#showRoutes").checked) drawLegs(d, di, byTitle);
  });
  return bounds;
}
