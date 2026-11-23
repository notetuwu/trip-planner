// The itinerary on the map: numbered stops per day, joined by their routes (each split group gets its own line).
import * as L from "leaflet";
import type { Day, ItineraryItem, LatLng } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { dayColor, fmtDate, fmtTime } from "../core/format";
import { session } from "../core/state";
import { type ByTitle, itemLoc } from "../geo/item-loc";
import { dayGroupColors, splitGroup } from "../trip/modes";
import { cssVar } from "./map";

/** While the group is split, its stops and routes take the group's colour (as in the plan); otherwise the day's. */
let groups: Record<string, number> = {}; // the day being drawn's
const colorFor = (x: ItineraryItem, di: number) => {
  const g = splitGroup(x);
  return g && g in groups ? cssVar(`--track-${groups[g]}`) || dayColor(di) : dayColor(di);
};
import { highlightItem } from "./days";
import { hoverBand, legTip } from "./legs";
import { itemMarkers, layers } from "./map";
import { dayLegs, legRoute } from "./routes";
import { isTransfer } from "./travel-day";
import { icon } from "../core/icons";

function drawStops(d: Day, di: number, byTitle: ByTitle, bounds: LatLng[]) {
  d.items.forEach((x, xi) => {
    const color = colorFor(x, di);
    const loc = isTransfer(x) ? null : itemLoc(x, d, byTitle);
    if (!loc) return;
    const note = loc.elsewhere ? ` · ${icon("warn")} the known place of this name is in ${esc(loc.elsewhere)}` : loc.approx ? " · approximate location (the model's estimate)" : "";
    const m = L.marker([loc.lat, loc.lng], {
      icon: L.divIcon({ className: "", html: `<div class="num-pin${loc.approx ? " approx" : ""}" style="--c:${color}">${xi + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
    }).bindTooltip(`${esc(fmtTime(x.time))} ${esc(x.place)}${note}`, { direction: "top", offset: [0, -10] })
      .bindPopup(`<b>${esc(x.place)}</b><div class="pop-meta">${esc(fmtDate(d.date))} · ${esc(fmtTime(x.time))}${splitGroup(x) ? ` · ${esc(x.group)}` : ""}</div><div>${esc(x.description)}</div>`)
      .on("click", () => highlightItem(di, xi))
      .addTo(layers.items);
    itemMarkers.set(`${di}-${xi}`, m);
    bounds.push([loc.lat, loc.lng]);
  });
}

function drawLegs(d: Day, di: number, byTitle: ByTitle) {
  for (const leg of dayLegs(d, byTitle)) {
    const color = leg.group && leg.group in groups ? cssVar(`--track-${groups[leg.group]}`) || dayColor(di) : dayColor(di);
    const r = legRoute(leg);
    const line = r ? r.c : [leg.from, leg.to];
    // Walking: dotted along paths; road: solid; train/tram/ferry/flight (or no route found): long dashes, straight.
    const style: L.PolylineOptions = r && leg.mode === "foot" ? { weight: 4, dashArray: "1 7" }
      : r ? { weight: 4 }
      : leg.mode === "straight" || r === null ? { weight: 3, dashArray: "8 8" }
      : { weight: 2, dashArray: "2 6", opacity: .4 }; // still being routed
    // Groups often share a stretch (the same train out of town): earlier groups are drawn wider underneath, so each
    // one's colour still shows along the shared part.
    const extra = leg.group && leg.group in groups ? (Math.max(...Object.values(groups)) - groups[leg.group]) * 3 : 0;
    const vis = L.polyline(line, { color, opacity: extra ? 1 : .8, lineCap: "round", interactive: false, ...style, weight: (style.weight || 3) + extra }).addTo(layers.routes);
    hoverBand(line, legTip(d, leg, r), vis).on("click", () => highlightItem(di, leg.xi)).addTo(layers.routes);
  }
}

/** Draws the selected day (or all days); returns the stops' positions for fitting the map. */
export function drawDays(days: Day[], byTitle: ByTitle): LatLng[] {
  const bounds: LatLng[] = [];
  days.forEach((d, di) => {
    groups = dayGroupColors(d.items, di);
    if (session.selectedDay != null && session.selectedDay !== di) return;
    drawStops(d, di, byTitle, bounds);
    if ($<HTMLInputElement>("#showRoutes").checked) drawLegs(d, di, byTitle);
  });
  return bounds;
}
