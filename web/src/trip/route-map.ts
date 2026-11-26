// A small map in "Plan a route": the suggested stays as numbered pins joined in order (start and end too), their day
// trips as thin lines out to a dot, and the stops on the way. The towns are looked up like the trip's stays (same
// cache), so the pins appear as the answers come in.
import * as L from "leaflet";
import { esc } from "../core/dom";
import { geo, geoKey, geocode, onGeocoded } from "../geo/geocode";
import type { GeoHit } from "../../../shared/types";

interface Planned {
  start: string; end: string;
  stays: { city: string; country: string; dayTrips?: { place: string }[] }[];
  legs: { via?: { place: string; lat: number; lng: number }[] }[];
}

let map: L.Map | null = null, layer: L.LayerGroup | null = null, shown: Planned | null = null, fitted = "";

const q = (name: string, country = "") => (country && !name.toLowerCase().includes(country.toLowerCase()) ? `${name}, ${country}` : name);
const at = (query: string): GeoHit | null => geo[geoKey(query)] || null;

function draw() {
  if (!map || !layer || !shown) return;
  layer.clearLayers();
  const p = shown;
  const pts: L.LatLng[] = [], all: L.LatLng[] = [];
  const start = at(p.start), end = at(p.end || p.start);
  if (start) { pts.push(L.latLng(start.lat, start.lng)); all.push(pts[0]); }
  p.stays.forEach((s, i) => {
    const g = at(q(s.city, s.country));
    // The stops on the way to this stay, in order, then the stay.
    for (const v of p.legs[i]?.via || []) {
      const ll = L.latLng(v.lat, v.lng);
      pts.push(ll); all.push(ll);
      L.circleMarker(ll, { radius: 5, color: "#fff", weight: 1.5, fillColor: "#b7791f", fillOpacity: 1 }).bindTooltip(`On the way: ${esc(v.place)}`).addTo(layer!);
    }
    if (!g) return;
    const ll = L.latLng(g.lat, g.lng);
    pts.push(ll); all.push(ll);
    L.marker(ll, { zIndexOffset: 1000, icon: L.divIcon({ className: "", html: `<div class="stay-pin"><b>${i + 1}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }) })
      .bindTooltip(esc(s.city), { direction: "right", offset: [12, -16], permanent: true }).addTo(layer!);
    for (const t of s.dayTrips || []) {
      const d = at(q(t.place, s.country));
      if (!d) continue;
      const dl = L.latLng(d.lat, d.lng);
      all.push(dl);
      L.polyline([ll, dl], { color: "#2b6cb0", weight: 2, dashArray: "4 6", opacity: .8 }).addTo(layer!);
      L.circleMarker(dl, { radius: 5, color: "#2b6cb0", weight: 2, fillColor: "#fff", fillOpacity: 1 }).bindTooltip(`Day trip from ${esc(s.city)}: ${esc(t.place)}`).addTo(layer!);
    }
  });
  for (const v of p.legs.at(-1)?.via || []) { const ll = L.latLng(v.lat, v.lng); pts.push(ll); all.push(ll); }
  if (end) { pts.push(L.latLng(end.lat, end.lng)); all.push(pts.at(-1)!); }
  if (start) L.circleMarker(pts[0], { radius: 6, color: "#fff", weight: 2, fillColor: "#bc002d", fillOpacity: 1 }).bindTooltip(`Start: ${esc(p.start)}`).addTo(layer);
  if (pts.length > 1) L.polyline(pts, { color: "#bc002d", weight: 2.5, opacity: .8, dashArray: "6 6" }).addTo(layer);
  // Fit once everything known so far is in, and again when more arrives (not on every redraw). Without an animation:
  // opening another trip removes the map, and an animation still running would then fail.
  const sig = all.map((l) => l.toString()).join("|");
  if (all.length && sig !== fitted) { fitted = sig; map.fitBounds(L.latLngBounds(all).pad(0.12), { maxZoom: 9, animate: false }); }
}

/** Shows a planned route on the map in `el` (made the first time), looking up the towns it doesn't know yet. */
export function showRouteMap(el: HTMLElement, plan: Planned) {
  shown = plan; fitted = "";
  if (!map || map.getContainer() !== el) {
    map?.remove();
    map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([48, 10], 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
    layer = L.layerGroup().addTo(map);
    el.addEventListener("click", () => map?.scrollWheelZoom.enable(), { once: true });
  }
  geocode([
    { q: plan.start, first: true },
    { q: plan.end || plan.start, first: true },
    ...plan.stays.flatMap((s) => [{ q: q(s.city, s.country), first: true }, ...(s.dayTrips || []).map((t) => ({ q: q(t.place, s.country), first: true }))]),
  ]);
  // The dialog has just laid itself out: let the map measure its box.
  requestAnimationFrame(() => { map?.invalidateSize(); draw(); });
}

/** After the dialog opens (a restored route was drawn while it was hidden, with no size): measure and fit again. */
export function refreshRouteMap() {
  if (!map) return;
  requestAnimationFrame(() => { map?.invalidateSize(); fitted = ""; draw(); });
}

/** Gone with the result (Start over). */
export function hideRouteMap() { map?.remove(); map = null; layer = null; shown = null; }

onGeocoded(() => draw());
