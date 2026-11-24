// "Set location" on a stop: where it really is, when the planner's or the lookup's spot is wrong (or only a guess).
// Search for it near that day, or click the map. A location set here is trusted from then on (pinned).
import type { GeoHit } from "../../../shared/types";
import { api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { stayLoc, stayOn } from "../geo/locate";
import { drawMap } from "../map/draw";
import * as mapModule from "../map/map";
import { renderItinerary } from "./render";
import { transferEnds } from "../trip/modes";

/** Puts the stop where they said and redraws the plan and the map. */
function setAt(di: number, xi: number, lat: number, lng: number, label: string) {
  const x = state.itinerary?.days[di]?.items[xi];
  if (!x) return;
  x.lat = lat; x.lng = lng; x.pinned = true; delete x.fixed;
  save(); renderItinerary(); drawMap({ fit: false });
  toast(`${x.place}: set to ${label}`);
}

/** Opens the small "where is it?" panel under a stop. */
export function openPin(di: number, xi: number, anchor: HTMLElement) {
  document.querySelector(".pin-panel")?.remove();
  const d = state.itinerary?.days[di], x = d?.items[xi];
  if (!d || !x) return;
  const here = itemLoc(x, d, byTitleMap()) || stayLoc(stayOn(d)!);
  // A transfer ("Rigi Kulm → Vitznau"): where it arrives, so the way on the map goes through there.
  const ends = transferEnds(x);
  const panel = document.createElement("div");
  panel.className = "pin-panel";
  panel.innerHTML = `<div class="pin-head"><b>${ends ? `Where does it arrive in ${esc(ends[1])}?` : `Where is ${esc(x.place)}?`}</b><button type="button" class="icon-btn" data-pin-close title="Close">${icon("x")}</button></div>
    <form class="pin-search"><input type="search" value="${esc(ends ? ends[1] : `${x.place}, ${d.city.split("/")[0].trim()}`)}" placeholder="Name and town, or an address"><button class="btn">Search</button></form>
    <ul class="pin-results"></ul>
    <div class="pin-foot"><button type="button" class="link-btn" data-pin-map>${icon("crosshair")} Click it on the map instead</button></div>`;
  anchor.closest("li.item")?.appendChild(panel);
  const input = panel.querySelector("input")!, list = panel.querySelector<HTMLElement>(".pin-results")!;
  const search = async () => {
    const q = input.value.trim();
    if (!q) return;
    list.innerHTML = `<li class="hint">Searching…</li>`;
    try {
      const params = new URLSearchParams({ q, ...(here ? { lat: here.lat.toFixed(4), lng: here.lng.toFixed(4) } : {}) });
      const hits = await api<GeoHit[]>(`/api/search?${params}`);
      list.innerHTML = hits.length ? hits.slice(0, 6).map((h, i) => `<li><button type="button" data-hit="${i}"><b>${esc(h.name || h.label.split(",")[0])}</b><small>${esc(h.label)}</small></button></li>`).join("")
        : `<li class="hint">Nothing found. Try the town or address, or click it on the map.</li>`;
      list.querySelectorAll<HTMLButtonElement>("[data-hit]").forEach((b) => { b.onclick = () => { const h = hits[+b.dataset.hit!]; panel.remove(); setAt(di, xi, h.lat, h.lng, h.label.split(",").slice(0, 2).join(",")); }; });
    } catch (e) { list.innerHTML = `<li class="hint">${esc((e as Error).message)}</li>`; }
  };
  panel.querySelector("form")!.onsubmit = (e) => { e.preventDefault(); search(); };
  panel.querySelector<HTMLButtonElement>("[data-pin-close]")!.onclick = () => panel.remove();
  // The map's own picking: the click sets the spot instead of offering to add a place there (Cancel or Esc gives up).
  panel.querySelector<HTMLButtonElement>("[data-pin-map]")!.onclick = () => {
    const m = mapModule.map;
    if (!m) return;
    panel.remove();
    if (here) m.flyTo([here.lat, here.lng], Math.max(m.getZoom(), 13));
    mapModule.pickOnMap(ends ? `where it arrives in ${ends[1]}` : x.place, (at) => setAt(di, xi, at.lat, at.lng, "the spot you clicked"));
  };
  input.focus(); input.select();
  search();
}
