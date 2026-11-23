// The map data and script of the phone export. The script is plain JavaScript inside the exported file: it jumps to
// today's day and, when online, draws the stays, stops and routes with Leaflet from a CDN.
import { fmtTime } from "../core/format";
import type { LatLng } from "../../../shared/types";
import { dayColor } from "../core/format";
import { state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { stayLoc } from "../geo/locate";
import { dayLegs, legRoute } from "../map/routes";

export function offlineMapData() {
  const it = state.itinerary!, byTitle = byTitleMap();
  return {
    stays: state.stays.map((s) => ({ s, l: stayLoc(s) })).filter((x) => x.l).map(({ s, l }) => [l!.lat, l!.lng, s.city]),
    days: it.days.map((d, i) => ({
      c: dayColor(i),
      pts: d.items.map((x, xi) => { const l = itemLoc(x, d, byTitle); return l && [l.lat, l.lng, `${xi + 1}`, `${fmtTime(x.time)} ${x.place}`]; }).filter(Boolean),
      // Each leg along its route where one is known (rounded to keep the file small); dashed straight lines otherwise.
      lines: dayLegs(d, byTitle).map((leg) => {
        const r = legRoute(leg);
        return r ? { c: r.c.map(([a, b]): LatLng => [+a.toFixed(4), +b.toFixed(4)]), foot: leg.mode === "foot" } : { c: [leg.from, leg.to], dash: true };
      }),
    })),
  };
}

export const OFFLINE_SCRIPT = `
  // A stay's heading folds its days away and back.
  document.querySelectorAll("[data-fold-stay]").forEach((el) => el.addEventListener("click", () => el.closest(".stay-group").classList.toggle("folded")));
  // During the trip, jump straight to today.
  const today = new Date().toLocaleDateString("sv");
  document.querySelectorAll('[data-date="' + today + '"]').forEach((el) => el.classList.add("today"));
  const day = document.querySelector('.day[data-date="' + today + '"]');
  if (day && !location.hash) day.scrollIntoView();
  if (window.L) {
    const el = document.getElementById("map"); el.hidden = false;
    const map = L.map(el);
    // Not OpenStreetMap's tiles: a downloaded file sends no Referer, and OSM blocks such requests. Esri's don't need one.
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }).addTo(map);
    const all = [];
    // Same look as the planner: each day's route and numbered stops, plus the dashed route between stays on top.
    DATA.days.forEach((d) => {
      (d.lines || []).forEach((l) => L.polyline(l.c, { color: d.c, weight: l.dash ? 3 : 4, opacity: .8, lineCap: "round", dashArray: l.dash ? "8 8" : l.foot ? "1 7" : null }).addTo(map));
      d.pts.forEach((p) => {
        all.push([p[0], p[1]]);
        L.marker([p[0], p[1]], { icon: L.divIcon({ className: "", html: '<div class="num-pin" style="--c:' + d.c + '">' + p[2] + "</div>", iconSize: [22, 22], iconAnchor: [11, 11] }) }).bindTooltip(p[3]).addTo(map);
      });
    });
    if (DATA.stays.length > 1) L.polyline(DATA.stays.map((s) => [s[0], s[1]]), { color: "#bc002d", weight: 2.5, dashArray: "6 6", opacity: .85 }).addTo(map);
    DATA.stays.forEach(([lat, lng, city], i) => {
      all.push([lat, lng]);
      L.marker([lat, lng], { zIndexOffset: 1000, icon: L.divIcon({ className: "", html: '<div class="stay-pin"><b>' + (i + 1) + "</b></div>", iconSize: [30, 30], iconAnchor: [15, 30] }) })
        .bindTooltip(city, { direction: "right", offset: [12, -16], permanent: true }).addTo(map);
    });
    if (all.length) map.fitBounds(L.latLngBounds(all).pad(.1)); else el.hidden = true;
  }`;
