// Stays on the map: numbered pins, the legs between them (driven ones along the road), and day trips.
import * as L from "leaflet";
import type { LatLng, RouteMode, TravelMode } from "../../../shared/types";
import { esc } from "../core/dom";
import { addDays, fmtDate, fmtDist, fmtDur } from "../core/format";
import { session, state } from "../core/state";
import { geo, geoKey } from "../geo/geocode";
import { distKm, stayLoc, stayMapsUrl } from "../geo/locate";
import { modeIcon, modeName } from "../trip/modes";
import { hoverBand } from "./legs";
import { cssVar, layers } from "./map";
import { requestRoutes, routeKey, routes } from "./routes";
import { icon } from "../core/icons";
import { byTitleMap } from "../geo/item-loc";
import { type ViaStop, viaStops } from "./travel-day";

interface StayLeg { from: LatLng; to: LatLng; mode?: TravelMode; label: string; trip?: boolean; place?: string; via?: ViaStop[] }

function stayLegs(): StayLeg[] {
  const legs: StayLeg[] = [], byTitle = byTitleMap();
  state.stays.forEach((s, i) => {
    const here = stayLoc(s); if (!here) return;
    const prev = i > 0 ? stayLoc(state.stays[i - 1]) : null;
    if (prev) legs.push({ from: [prev.lat, prev.lng], to: [here.lat, here.lng], mode: s.travel, label: `${state.stays[i - 1].city} → ${s.city}`, via: viaStops(i, byTitle) });
    for (const t of s.dayTrips || []) {
      const g = t.place ? geo[geoKey(t.place)] : null;
      // A day trip found hundreds of km away is a wrong match for its name, not somewhere to go and back in a day.
      if (g && distKm(here, g) < 300) legs.push({ from: [here.lat, here.lng], to: [g.lat, g.lng], mode: t.mode, label: `Day trip: ${s.city} ↔ ${t.place}`, trip: true, place: t.place });
    }
  });
  return legs;
}

/** Draws the stays; returns their pin positions (for fitting the map). */
export function drawStays(): LatLng[] {
  const accent = cssVar("--accent");
  const pts: LatLng[] = [];
  state.stays.forEach((s, i) => {
    const loc = stayLoc(s); if (!loc) return;
    pts.push([loc.lat, loc.lng]);
    const end = s.start ? addDays(s.start, s.nights) : "";
    L.marker([loc.lat, loc.lng], {
      icon: L.divIcon({ className: "", html: `<div class="stay-pin"><b>${i + 1}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }),
      zIndexOffset: 1000,
    }).bindTooltip(esc(s.city), { direction: "right", offset: [12, -16], permanent: session.selectedDay == null })
      .bindPopup(`<b>${esc(s.city)}</b><div class="pop-meta">${s.start ? `${fmtDate(s.start)} → ${fmtDate(end)} · ` : ""}${s.nights} night${s.nights == 1 ? "" : "s"}</div>${s.hotel ? `<div>${icon("bed")} ${esc(s.hotel)}</div>` : ""}<div><a href="${esc(stayMapsUrl(s))}" target="_blank" rel="noopener">${icon("pin")} Open in Google Maps</a></div>`)
      .addTo(layers.stays);
  });

  const driven: { mode: RouteMode; from: LatLng; to: LatLng }[] = [];
  for (const l of stayLegs()) {
    // By road, or by train along the tracks; ferries and flights stay straight lines.
    const how: RouteMode | null = l.mode === "car" || l.mode === "bus" ? "car" : l.mode === "train" ? "train" : null;
    const byRoad = !!how;
    // Through the travel day's stops on the way: one route made of the pieces between them.
    const pts: LatLng[] = [l.from, ...(l.via || []).map((v) => v.loc), l.to];
    const pieces = pts.slice(1).map((to, k) => ({ mode: how || "car", from: pts[k], to }));
    const got = byRoad ? pieces.map((p) => routes[routeKey(p.mode, p.from, p.to)]) : [];
    const r = byRoad && got.every(Boolean)
      ? { c: got.flatMap((g) => g!.c), d: got.reduce((n, g) => n + g!.d, 0), t: got.reduce((n, g) => n + g!.t, 0) } : null;
    if (byRoad) driven.push(...pieces);
    const via = l.via?.length ? ` via ${l.via.map((v) => esc(v.name)).join(", ")}` : "";
    const tip = `${modeIcon(l.mode) || icon("arrowLeftRight")} ${esc(l.label)}${via}${l.mode ? ` · ${modeName(l.mode)}` : ""}${r ? ` · ${fmtDist(r.d)}, ${fmtDur(r.t)}` : ""}`;
    const line = r ? r.c : pts;
    const vis = L.polyline(line, {
      color: accent, weight: r ? 3 : l.trip ? 1.5 : 2, opacity: l.trip ? .55 : .75, interactive: false,
      dashArray: r ? undefined : l.mode === "flight" ? "2 8" : "6 6",
    }).addTo(layers.stays);
    hoverBand(line, tip, vis).addTo(layers.stays);
    if (l.trip) L.circleMarker(l.to, { radius: 5, color: accent, weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip(`${modeIcon(l.mode) || icon("pin")} Day trip: ${esc(l.place)}`, { direction: "top" }).addTo(layers.stays);
  }
  if (driven.length) requestRoutes(driven);
  return pts;
}
