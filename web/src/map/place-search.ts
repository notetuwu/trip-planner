// The search bar on a map, like a maps app's: a round box with results as they type (Photon only: Nominatim's rules
// don't allow a search per key press), an icon for what each is, arrow keys, ✕ to clear, and Esc to close the results.
// Biased to where the map is. The first row searches the map's view for everything that matches ("McDonald's in this
// area", "konbini", "atm"; Enter does the same when no result is picked): red pins and a list, the names at once and the
// kinds of place added when they come (server/geo/area-search.ts); after the map is moved, "Search this area" asks again.
// Used by the main map and by the Photos window's Place on map.
import * as L from "leaflet";
import type { GeoHit } from "../../../shared/types";
import { api, esc } from "../core/dom";
import { type IconName, icon } from "../core/icons";
import { countryCodes } from "../geo/locate";

/** A search result's icon, by what it is. */
const kindIcon = (k: string): IconName =>
  /station|halt|subway|train|tram_stop|platform|railway/.test(k) ? "train" : /bus/.test(k) ? "bus"
    : /hotel|hostel|guest_house|motel/.test(k) ? "hotel"
      : /residential|primary|secondary|tertiary|trunk|motorway|footway|pedestrian|road|living_street|unclassified|service|path|street/.test(k) ? "route"
        : /city|town|village|suburb|neighbourhood|quarter|hamlet|district|state|country|county/.test(k) ? "map" : "pin";

export interface PlaceSearch {
  /** Empties the field, closes the results and takes the area's pins away (and calls onClear). */
  clear: () => void;
  /** Closes the results; true when they were open. */
  close: () => boolean;
}

/** How close (metres) a kind-of-place result is to a name result to be the same place. */
const SAME = 40;

export function placeSearch(form: HTMLFormElement, o: {
  map: () => L.Map | null; placeholder: string; onPick: (hit: GeoHit) => void; onClear?: () => void;
  /** Where the area's pins go (a layer of the map's own, else one of this search's). */
  layer?: () => L.LayerGroup | null;
}): PlaceSearch {
  form.classList.add("place-search");
  form.setAttribute("role", "search");
  form.autocomplete = "off";
  form.innerHTML = `<div class="ps-box">${icon("search")}<input type="search" placeholder="${esc(o.placeholder)}" aria-label="${esc(o.placeholder)}">
      <button type="button" class="ps-clear" title="Clear" aria-label="Clear" hidden>${icon("x")}</button></div>
    <ul role="listbox" hidden></ul>`;
  const again = document.createElement("button");
  again.type = "button"; again.className = "ps-again"; again.hidden = true;
  again.innerHTML = `${icon("search")} Search this area`;
  form.after(again);
  const query = form.querySelector("input")!, results = form.querySelector("ul")!, clearBtn = form.querySelector<HTMLButtonElement>(".ps-clear")!;
  let hits: GeoHit[] = [], asked = 0, active = -1, typing = 0;
  const cache = new Map<string, GeoHit[]>();

  // ---- The area: what's searched, what was found, and its pins ----
  let area: { q: string; hits: GeoHit[]; more: boolean; error: string; box: L.LatLngBounds } | null = null;
  let own: L.LayerGroup | null = null, watching: L.Map | null = null;
  const pinLayer = () => o.layer?.() || (own ||= o.map() ? L.layerGroup().addTo(o.map()!) : null);
  const typed = () => query.value.trim();

  /** The rows: the area search first (while typing), then what was found by name; or the area's own list. */
  function show() {
    results.hidden = false;
    const text = typed();
    if (area && text === area.q && !hits.length) return showArea();
    const areaRow = text.length >= 2 ? `<li data-area class="ps-area-row${active === -1 ? " active" : ""}" role="option">${icon("search")}<div><b>${esc(text)}</b><span>Search in this area</span></div></li>` : "";
    results.innerHTML = areaRow + (hits.length
      ? hits.map((r, i) => `<li data-r="${i}" role="option" aria-selected="${i === active}"${i === active ? ' class="active"' : ""}>${icon(kindIcon(r.kind || ""))}<div><b>${esc(r.name)}</b><span>${esc(r.label.replace(new RegExp(`^${r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},\\s*`), ""))}</span></div></li>`).join("")
      : text.length >= 2 ? "" : `<li class="muted">Searching…</li>`);
    if (!results.innerHTML) results.hidden = true;
  }
  function showArea() {
    if (!area) return;
    results.hidden = false;
    const n = area.hits.length;
    const head = `<li class="ps-area-head">${n ? `${n}${n >= 50 && !area.more ? "+" : ""} result${n === 1 ? "" : "s"} for “${esc(area.q)}” in this area` : area.more ? `Searching this area for “${esc(area.q)}”…` : `Nothing called “${esc(area.q)}” in this area.`}${area.more && n ? ` <span>finding more…</span>` : ""}${area.error ? `<em>${esc(area.error)}</em>` : ""}</li>`;
    results.innerHTML = head + area.hits.map((r, i) => `<li data-a="${i}" role="option"${i === active ? ' class="active"' : ""}>${icon(kindIcon(r.kind || ""))}<div><b>${esc(r.name)}</b><span>${esc(r.label.replace(new RegExp(`^${r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},\\s*`), ""))}</span></div></li>`).join("");
  }
  function drawPins() {
    const layer = pinLayer();
    if (!layer) return;
    for (const l of [...layer.getLayers()]) if ((l as L.Marker & { psArea?: boolean }).psArea) layer.removeLayer(l);
    for (const r of area?.hits || []) {
      const mk = L.marker([r.lat, r.lng], { keyboard: false, zIndexOffset: -300, icon: L.divIcon({ className: "", html: `<div class="ps-pin"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }) }) as L.Marker & { psArea?: boolean };
      mk.psArea = true;
      mk.bindTooltip(esc(r.name), { direction: "top", offset: [0, -8] }).on("click", () => pick(r, true)).addTo(layer);
    }
  }
  /** Everything in the map's view that matches: the names at once, the kinds of place when they come. */
  async function searchArea(q = typed()) {
    const m = o.map();
    if (!m || q.length < 2) return;
    const mine = ++asked, b = m.getBounds();
    const params = (what: string) => `/api/search/area?${new URLSearchParams({ q, what, s: b.getSouth().toFixed(5), w: b.getWest().toFixed(5), n: b.getNorth().toFixed(5), e: b.getEast().toFixed(5) })}`;
    clearTimeout(typing);
    hits = []; active = -1; again.hidden = true;
    area = { q, hits: [], more: true, error: "", box: b };
    showArea(); drawPins();
    watch(m);
    const names = api<GeoHit[]>(params("names")).catch((e) => { if (area) area.error = (e as Error).message; return [] as GeoHit[]; });
    const kinds = api<GeoHit[]>(params("kinds")).catch((e) => { if (area && !area.hits.length) area.error = (e as Error).message; return [] as GeoHit[]; });
    const named = await names;
    if (mine !== asked || !area) return;
    area.hits = named; area.error = named.length ? "" : area.error;
    showArea(); drawPins();
    const more = await kinds;
    if (mine !== asked || !area) return;
    // The kinds' places that aren't one of the names already.
    for (const k of more) if (!area.hits.some((h) => L.latLng(h.lat, h.lng).distanceTo([k.lat, k.lng]) < SAME)) area.hits.push(k);
    area.more = false;
    if (area.hits.length) area.error = "";
    showArea(); drawPins();
  }
  /** After the map moves away from the area searched, "Search this area" asks again. */
  function watch(m: L.Map) {
    if (watching === m) return;
    watching = m;
    m.on("moveend", () => { again.hidden = !area || area.box.contains(m.getBounds().pad(-0.25)); });
  }
  again.onclick = () => { if (area) { query.value = area.q; searchArea(area.q); } };

  async function search(quick: boolean) {
    const text = typed(), mine = ++asked, m = o.map();
    if (!text || !m) return;
    const c = m.getCenter().wrap(), key = `${quick ? "q" : "f"}|${text.toLowerCase()}|${c.lat.toFixed(1)},${c.lng.toFixed(1)}`;
    if (!hits.length) show();
    try {
      const got = cache.get(key) || await api<GeoHit[]>(`/api/search?${new URLSearchParams({ q: text, lat: c.lat.toFixed(4), lng: c.lng.toFixed(4), cc: countryCodes(), ...(quick ? { quick: "1" } : {}) })}`);
      cache.set(key, got);
      if (mine !== asked) return;
      hits = got; active = -1;
      show();
    } catch (e) { if (mine === asked) results.innerHTML = `<li class="muted">${esc((e as Error).message)}</li>`; }
  }
  /** A result picked: the map goes there (the area's pins stay when it's one of them). */
  function pick(r: GeoHit, fromArea = false) {
    results.hidden = true;
    if (!fromArea) { query.value = r.name; area = null; drawPins(); again.hidden = true; }
    clearBtn.hidden = false;
    o.onPick(r);
  }
  function clear() {
    asked++; clearTimeout(typing);
    query.value = ""; hits = []; active = -1; area = null;
    results.hidden = true; clearBtn.hidden = true; again.hidden = true;
    drawPins();
    o.onClear?.();
  }

  query.oninput = () => {
    clearTimeout(typing);
    clearBtn.hidden = !query.value;
    if (!query.value) return clear();
    if (area && typed() !== area.q) { area = null; drawPins(); again.hidden = true; }
    hits = []; active = -1;
    if (typed().length < 2) { asked++; results.hidden = true; return; }
    show();
    typing = window.setTimeout(() => search(true), 250);
  };
  query.onfocus = () => { if (typed() && (hits.length || area)) show(); };
  query.onkeydown = (e) => {
    const list = area && typed() === area.q && !hits.length ? area.hits : hits;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!list.length) return;
      e.preventDefault();
      // (Past either end: back to the area search, or the field.)
      const n = list.length;
      active = e.key === "ArrowDown" ? (active + 1 >= n ? -1 : active + 1) : (active < 0 ? n - 1 : active - 1);
      if (list === hits) show(); else showArea();
    } else if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(typing);
      // A result picked with the arrows goes there; otherwise the area is searched, like a maps app.
      if (active >= 0 && list[active]) pick(list[active], list !== hits);
      else searchArea();
    } else if (e.key === "Escape" && (!results.hidden || query.value)) {
      // Esc closes the results (then empties the field), not a window it's in.
      e.preventDefault(); e.stopPropagation();
      if (!results.hidden) results.hidden = true; else clear();
    }
  };
  form.onsubmit = (e) => e.preventDefault();
  results.onmousedown = (e) => e.preventDefault(); // (the field keeps the focus)
  results.onclick = (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li");
    if (!li) return;
    if (li.dataset.area != null) searchArea();
    else if (li.dataset.r != null && hits[+li.dataset.r]) pick(hits[+li.dataset.r]);
    else if (li.dataset.a != null && area?.hits[+li.dataset.a]) pick(area.hits[+li.dataset.a], true);
  };
  clearBtn.onclick = () => { clear(); query.focus(); };
  query.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== query) results.hidden = true; }, 150));

  return { clear, close: () => { const was = !results.hidden; results.hidden = true; return was; } };
}
