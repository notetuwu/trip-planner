// Search by name (biased to the current map view); picking a result opens the add form there.
import * as L from "leaflet";
import type { GeoHit } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { session } from "../core/state";
import { countryCodes } from "../geo/locate";
import { openAddPopup } from "./add";
import { map } from "./map";

let results: GeoHit[] = [];

async function search(e: Event) {
  e.preventDefault();
  const q = $<HTMLInputElement>("#mapSearchQ").value.trim(), ul = $("#mapResults");
  if (!q || !map) return;
  const c = map.getCenter();
  ul.hidden = false;
  ul.innerHTML = `<li class="muted">Searching…</li>`;
  try {
    results = await api<GeoHit[]>(`/api/search?${new URLSearchParams({ q, lat: c.lat.toFixed(4), lng: c.lng.toFixed(4), cc: countryCodes() })}`);
    ul.innerHTML = results.length
      ? results.map((r, i) => `<li data-r="${i}"><b>${esc(r.name)}</b><span>${esc(r.label)}</span></li>`).join("")
      : `<li class="muted">Nothing found. Try a shorter name, or click the spot on the map.</li>`;
  } catch (err) { ul.innerHTML = `<li class="muted">${esc((err as Error).message)}</li>`; }
}

function pick(e: Event) {
  const i = (e.target as HTMLElement).closest<HTMLElement>("[data-r]")?.dataset.r;
  const r = i != null ? results[+i] : undefined;
  if (!r || !map) return;
  $("#mapResults").hidden = true;
  const at = L.latLng(r.lat, r.lng);
  session.userMoved = true;
  map.closePopup();
  const open = () => openAddPopup(at, { name: r.name, label: r.label, fromList: session.places.some((p) => p.title === r.name) });
  if (map.getCenter().distanceTo(at) < 5 && map.getZoom() >= 16) return open();
  map.flyTo(at, Math.max(map.getZoom(), 16), { duration: .8 });
  map.once("moveend", open);
}

export function initMapSearch() {
  $("#mapSearch").onsubmit = search;
  $("#mapResults").onclick = pick;
  $("#mapSearchQ").addEventListener("keydown", (e) => { if (e.key === "Escape") $("#mapResults").hidden = true; });
}
