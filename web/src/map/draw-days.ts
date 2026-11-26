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
import { hoverBand, legTip, rideColour, rideIcon, ridesHtml } from "./legs";
import { walksOf } from "./walks";
import { itemMarkers, layers } from "./map";
import { dayLegs, flightArc, type Leg, legRoute } from "./routes";
import { isTransfer, onMap } from "./travel-day";
import { legStops } from "../trip/split-tree";
import { icon } from "../core/icons";

function drawStops(d: Day, di: number, byTitle: ByTitle, bounds: LatLng[]) {
  d.items.forEach((x, xi) => {
    const color = colorFor(x, di);
    const loc = onMap(x) ? itemLoc(x, d, byTitle) : null;
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

/** The lines lit up now, with how they were drawn. */
let lit: L.Polyline[] = [];
/** How each line was drawn, taken once (before any hover made it thicker), so putting it back never keeps it thick. */
const drawnAs = new WeakMap<L.Polyline, { weight: number; opacity: number }>();
const baseOf = (line: L.Polyline) => {
  let b = drawnAs.get(line);
  if (!b) drawnAs.set(line, (b = { weight: line.options.weight ?? 3, opacity: line.options.opacity ?? 1 }));
  return b;
};
/** Lights up the whole way to these stops (their legs, walks and rides) and any other lines given, thicker and in
 *  front; what was lit before goes back. */
export function lightLegs(keys: string[], others: L.Polyline[] = []) {
  for (const line of lit) line.setStyle(baseOf(line));
  lit = [];
  for (const line of new Set([...others, ...keys.flatMap((k) => legLines.get(k) || [])])) {
    lit.push(line);
    line.setStyle({ weight: baseOf(line).weight + 4, opacity: 1 });
    line.bringToFront();
  }
}

/** The lines drawn for each leg, by "<day>-<stop>": the stop it leads to, and any transfer on the way to it (whose trip
 *  it is). Hovering a stop in the itinerary lights them up. */
export const legLines = new Map<string, L.Polyline[]>();
const keep = (d: Day, di: number, leg: Leg, ...lines: L.Polyline[]) => {
  for (const line of lines) baseOf(line); // as drawn, before anything lights it up
  for (const k of legStops(d.items, leg, splitGroup, isTransfer)) legLines.set(`${di}-${k}`, [...(legLines.get(`${di}-${k}`) || []), ...lines]);
};

function drawLegs(d: Day, di: number, byTitle: ByTitle) {
  const legs = dayLegs(d, byTitle).map((leg) => {
    const r = legRoute(leg);
    const line = r ? r.c : leg.mode === "flight" ? flightArc(leg.from, leg.to) : [leg.from, leg.to];
    const color = leg.group && leg.group in groups ? cssVar(`--track-${groups[leg.group]}`) || dayColor(di) : dayColor(di);
    return { leg, r, line, color };
  });
  for (const { leg, r, line, color } of legs) {
    // Walking: dotted along paths; bike: short dashes along cycle paths; road, rail, tram and metro: solid; boat: long
    // dashes and cable car: dash-dot (along their route, or straight when there's none); flight: a thin dotted arc;
    // anything with no route found: dashes, straight.
    const style: L.PolylineOptions = r && leg.mode === "foot" ? { weight: 4, dashArray: "1 7" }
      : r && leg.mode === "bike" ? { weight: 4, dashArray: "6 5" }
      : leg.mode === "flight" ? { weight: 2.5, dashArray: "2 8" }
      : leg.mode === "ferry" && r !== undefined ? { weight: r ? 4 : 3, dashArray: "14 7" }
      // Cable car or gondola: a thin line with ticks, like the cable on a map.
      : leg.mode === "lift" && r !== undefined ? { weight: 3, dashArray: "10 3 2 3" }
      : r ? { weight: 4 }
      : leg.mode === "straight" || r === null ? { weight: 3, dashArray: "8 8" }
      : { weight: 2, dashArray: "2 6", opacity: .4 }; // still being routed
    const rides = (r?.rides || []).filter((x) => x.c && x.c.length > 1);
    // A public transport leg: the walks to and from the stops (and between them) dotted, the rides solid on top.
    const base = rides.length ? { ...style, weight: 3, dashArray: "1 6" } : style;
    // (Only where they walk: under a ride it would show through when hovered.)
    const drawn = rides.length ? walksOf(line, rides.map((x) => x.c!)) : [line];
    const vis = L.polyline(drawn, { color, opacity: .8, lineCap: "round", interactive: false, ...base }).addTo(layers.routes);
    hoverBand(line, legTip(d, leg, r), vis).on("click", () => highlightItem(di, leg.xi)).addTo(layers.routes);
    keep(d, di, leg, vis);
    for (const ride of rides) {
      const c = rideColour(ride);
      // The ride solid in the day's colour (the walks around it dotted); its stops and badge in the line's colour.
      const rv = L.polyline(ride.c!, { color, weight: 4, opacity: .85, lineCap: "round", interactive: false }).addTo(layers.routes);
      keep(d, di, leg, rv);
      hoverBand(ride.c!, `${legTip(d, leg, null).split("<span")[0]}<div class="ride-tips">${ridesHtml([ride], leg.mode)}</div>`, rv).on("click", () => highlightItem(di, leg.xi)).addTo(layers.routes);
      // Where they get on: the line's badge, so where to change is plain on the map.
      L.marker([ride.on.lat, ride.on.lng], { pane: "rideStops", keyboard: false, bubblingMouseEvents: false,
        icon: L.divIcon({ className: "", html: `<div class="ride-board"><span class="line-chip" style="--c:${esc(c)}">${ride.line ? esc(ride.line) : icon(rideIcon(ride))}</span></div>`, iconSize: [0, 0] }) })
        .bindTooltip(`Get on: <b>${esc(ride.on.n || "Stop")}</b>${ride.dep ? ` · ${esc(ride.dep)}` : ""}<br>${ridesHtml([ride], leg.mode)}`, { direction: "top", offset: [0, -12], className: "leg-tip" })
        .on("click", () => highlightItem(di, leg.xi)).addTo(layers.routes);
      // The stops: where they get off always, those in between with a day on its own.
      const stops = session.selectedDay === di ? [...ride.stops, ride.off] : [ride.off];
      for (const s of stops) {
        L.circleMarker([s.lat, s.lng], { pane: "rideStops", radius: s === ride.off ? 5 : 3.5, color: c, weight: 2.5, fillColor: "#fff", fillOpacity: 1, bubblingMouseEvents: false })
          .bindTooltip(`${esc(s.n || "Stop")}${s === ride.off ? " · get off" : ""}`, { direction: "top", offset: [0, -5], className: "leg-tip" })
          .addTo(layers.routes);
      }
    }
  }
}

/** Draws the selected day (or all days); returns the stops' positions for fitting the map. */
export function drawDays(days: Day[], byTitle: ByTitle): LatLng[] {
  const bounds: LatLng[] = [];
  legLines.clear(); lit = [];
  days.forEach((d, di) => {
    groups = dayGroupColors(d.items, di);
    if (session.selectedDay != null && session.selectedDay !== di) return;
    drawStops(d, di, byTitle, bounds);
    if ($<HTMLInputElement>("#showRoutes").checked) drawLegs(d, di, byTitle);
  });
  return bounds;
}
