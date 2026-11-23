// The real maps on the cards in Your trips: OpenStreetMap with the trip's route on it (the stays joined in order, the
// line drawing itself in, the plan's stops as dots). Made only when a card scrolls into view, still (no dragging or
// zooming: a click opens the trip), and removed again when the cards are redrawn.
import * as L from "leaflet";
import type { TripCard } from "../../../shared/types";
import { hueOf } from "./trip-cards";

let maps: L.Map[] = [];
let watch: IntersectionObserver | null = null;

/** Removes the maps of the cards that were there before a redraw. */
export function clearTripMaps() {
  watch?.disconnect(); watch = null;
  for (const m of maps) m.remove();
  maps = [];
}

function makeMap(el: HTMLElement, c: TripCard) {
  const dark = document.documentElement.dataset.theme === "dark", h = hueOf(c.name);
  const colour = dark ? `hsl(${h} 85% 68%)` : `hsl(${h} 75% 38%)`;
  const map = L.map(el, {
    zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
    boxZoom: false, keyboard: false, touchZoom: false, zoomSnap: 0.25,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  const pts = [...c.route, ...c.dots];
  const bounds = L.latLngBounds(pts.map(([a, b]) => L.latLng(a, b)));
  // A one-town trip isn't shown at street level.
  map.fitBounds(bounds.pad(0.06), { maxZoom: 11, padding: [16, 16] });
  for (const [a, b] of c.dots) L.circleMarker([a, b], { radius: 2, stroke: false, fillColor: colour, fillOpacity: 0.45, interactive: false }).addTo(map);
  if (c.route.length > 1) {
    const line = L.polyline(c.route, { color: colour, weight: 3, opacity: 0.95, lineJoin: "round", interactive: false }).addTo(map);
    // The line draws itself in, from the first stay to the last.
    const path = line.getElement() as SVGPathElement | undefined;
    if (path?.getTotalLength) {
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`; path.style.strokeDashoffset = `${len}`;
      requestAnimationFrame(() => { path.style.transition = "stroke-dashoffset 1.3s ease-in-out"; path.style.strokeDashoffset = "0"; });
    }
  }
  c.route.forEach(([a, b], i) => L.circleMarker([a, b], {
    radius: i === 0 ? 6 : 4.5, color: colour, weight: 2.5, fillColor: i === 0 ? colour : dark ? "#1b1b1c" : "#fff", fillOpacity: 1, interactive: false,
  }).addTo(map));
  el.classList.add("ready");
  maps.push(map);
}

/** Puts a map into each card's [data-map] box once it's on screen (the route sketch shows until then). */
export function showTripMaps(root: HTMLElement, cards: TripCard[]) {
  clearTripMaps();
  const byName = new Map(cards.map((c) => [c.name, c]));
  watch = new IntersectionObserver((seen) => {
    for (const e of seen) {
      if (!e.isIntersecting) continue;
      watch?.unobserve(e.target);
      const el = e.target as HTMLElement, c = byName.get(el.dataset.map!);
      if (c && (c.route.length || c.dots.length)) makeMap(el, c);
    }
  }, { root: root.closest(".trips-body"), rootMargin: "200px" });
  root.querySelectorAll<HTMLElement>("[data-map]").forEach((el) => watch!.observe(el));
}
