// The search bar on a map, like a maps app's: a round box with results as they type (Photon only: Nominatim's rules
// don't allow a search per key press), an icon for what each is, arrow keys and Enter (which looks harder when typing
// found nothing), ✕ to clear, and Esc to close the results. Biased to where the map is. Used by the main map and by the
// Photos window's Place on map.
import type * as L from "leaflet";
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
  /** Empties the field and closes the results (and calls onClear). */
  clear: () => void;
  /** Closes the results; true when they were open. */
  close: () => boolean;
}

export function placeSearch(form: HTMLFormElement, o: { map: () => L.Map | null; placeholder: string; onPick: (hit: GeoHit) => void; onClear?: () => void }): PlaceSearch {
  form.classList.add("place-search");
  form.setAttribute("role", "search");
  form.autocomplete = "off";
  form.innerHTML = `<div class="ps-box">${icon("search")}<input type="search" placeholder="${esc(o.placeholder)}" aria-label="${esc(o.placeholder)}">
      <button type="button" class="ps-clear" title="Clear" aria-label="Clear" hidden>${icon("x")}</button></div>
    <ul role="listbox" hidden></ul>`;
  const query = form.querySelector("input")!, results = form.querySelector("ul")!, clearBtn = form.querySelector<HTMLButtonElement>(".ps-clear")!;
  let hits: GeoHit[] = [], asked = 0, active = -1, typing = 0;
  const cache = new Map<string, GeoHit[]>();

  function show(text: string) {
    results.hidden = false;
    results.innerHTML = hits.length
      ? hits.map((r, i) => `<li data-r="${i}" role="option" aria-selected="${i === active}"${i === active ? ' class="active"' : ""}>${icon(kindIcon(r.kind || ""))}<div><b>${esc(r.name)}</b><span>${esc(r.label.replace(new RegExp(`^${r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},\\s*`), ""))}</span></div></li>`).join("")
      : `<li class="muted">${text ? `Nothing found for “${esc(text)}”. Press Enter to look harder.` : "Searching…"}</li>`;
  }
  async function search(quick: boolean) {
    const text = query.value.trim(), mine = ++asked, m = o.map();
    if (!text || !m) return;
    const c = m.getCenter().wrap(), key = `${quick ? "q" : "f"}|${text.toLowerCase()}|${c.lat.toFixed(1)},${c.lng.toFixed(1)}`;
    if (!hits.length) show("");
    try {
      const got = cache.get(key) || await api<GeoHit[]>(`/api/search?${new URLSearchParams({ q: text, lat: c.lat.toFixed(4), lng: c.lng.toFixed(4), cc: countryCodes(), ...(quick ? { quick: "1" } : {}) })}`);
      cache.set(key, got);
      if (mine !== asked) return;
      hits = got; active = -1;
      show(text);
      if (!quick && hits.length === 1) pick(hits[0]);
    } catch (e) { if (mine === asked) results.innerHTML = `<li class="muted">${esc((e as Error).message)}</li>`; }
  }
  function pick(r: GeoHit) {
    results.hidden = true;
    query.value = r.name; clearBtn.hidden = false;
    o.onPick(r);
  }
  function clear() {
    asked++; clearTimeout(typing);
    query.value = ""; hits = []; active = -1;
    results.hidden = true; clearBtn.hidden = true;
    o.onClear?.();
  }

  query.oninput = () => {
    clearTimeout(typing);
    clearBtn.hidden = !query.value;
    const text = query.value.trim();
    if (!query.value) return clear();
    if (text.length < 2) { asked++; hits = []; results.hidden = true; return; }
    typing = window.setTimeout(() => search(true), 250);
  };
  query.onfocus = () => { if (hits.length && query.value.trim()) show(query.value.trim()); };
  query.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hits.length) return;
      e.preventDefault();
      // (Past either end: back in the field.)
      const n = hits.length;
      active = e.key === "ArrowDown" ? (active + 1 >= n ? -1 : active + 1) : (active < 0 ? n - 1 : active - 1);
      show(query.value.trim());
    } else if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(typing);
      if (!results.hidden && hits.length) pick(hits[Math.max(0, active)]);
      else search(false);
    } else if (e.key === "Escape" && (!results.hidden || query.value)) {
      // Esc closes the results (then empties the field), not a window it's in.
      e.preventDefault(); e.stopPropagation();
      if (!results.hidden) results.hidden = true; else clear();
    }
  };
  form.onsubmit = (e) => e.preventDefault();
  results.onmousedown = (e) => e.preventDefault(); // (the field keeps the focus)
  results.onclick = (e) => { const i = (e.target as HTMLElement).closest<HTMLElement>("[data-r]")?.dataset.r; if (i != null && hits[+i]) pick(hits[+i]); };
  clearBtn.onclick = () => { clear(); query.focus(); };
  query.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== query) results.hidden = true; }, 150));

  return { clear, close: () => { const was = !results.hidden; results.hidden = true; return was; } };
}
