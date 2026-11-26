// "Set location" on a stop, and "Set on the map" on a stay: where it really is, when the planner's or the lookup's spot is
// wrong (or only a guess). Search for it nearby, or click the map. A location set here is trusted from then on (pinned).
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

interface WhereOptions {
  /** Where the panel goes (appended at its end). */
  host: Element;
  title: string;
  /** What the search starts with. */
  query: string;
  /** Results near here first. */
  near?: { lat: number; lng: number } | null;
  /** What the map's picking mode says they're clicking. */
  mapLabel: string;
  /** An extra button in the foot (e.g. going back to the address), with what it does. */
  extra?: { html: string; onClick: () => void };
  onPick: (lat: number, lng: number, label: string) => void;
}

/** The small "where is it?" panel: a search (as they type, nearby first), and the map waiting for a click on the spot
 *  meanwhile, whichever they do first. */
export function wherePanel(o: WhereOptions) {
  document.querySelector(".pin-panel")?.remove();
  mapModule.stopPicking();
  const panel = document.createElement("div");
  panel.className = "pin-panel";
  panel.innerHTML = `<div class="pin-head"><b>${esc(o.title)}</b><button type="button" class="icon-btn" data-pin-close title="Close">${icon("x")}</button></div>
    <form class="pin-search"><input type="search" value="${esc(o.query)}" placeholder="Name and town, or an address"><button class="btn">Search</button></form>
    <ul class="pin-results"></ul>
    <div class="pin-foot"><span class="hint">${icon("crosshair")} Or click the spot on the map</span>${o.extra ? `<button type="button" class="link-btn" data-pin-extra>${o.extra.html}</button>` : ""}</div>`;
  o.host.appendChild(panel);
  const input = panel.querySelector("input")!, list = panel.querySelector<HTMLElement>(".pin-results")!;
  // As they type (Photon only: Nominatim's rules don't allow a search per key press); Enter or Search looks harder.
  let asked = 0, typing = 0;
  const search = async (quick = false) => {
    const q = input.value.trim(), mine = ++asked;
    clearTimeout(typing);
    if (!q) { list.innerHTML = ""; return; }
    if (!list.querySelector("[data-hit]")) list.innerHTML = `<li class="hint">Searching…</li>`;
    try {
      const params = new URLSearchParams({ q, ...(o.near ? { lat: o.near.lat.toFixed(4), lng: o.near.lng.toFixed(4) } : {}), ...(quick ? { quick: "1" } : {}) });
      const hits = await api<GeoHit[]>(`/api/search?${params}`);
      if (mine !== asked || !panel.isConnected) return;
      list.innerHTML = hits.length ? hits.slice(0, 6).map((h, i) => `<li><button type="button" data-hit="${i}"><b>${esc(h.name || h.label.split(",")[0])}</b><small>${esc(h.label)}</small></button></li>`).join("")
        : `<li class="hint">Nothing found${quick ? " yet: press Enter to look harder" : ". Try the town or address, or click it on the map"}.</li>`;
      list.querySelectorAll<HTMLButtonElement>("[data-hit]").forEach((b) => { b.onclick = () => { const h = hits[+b.dataset.hit!]; close(); o.onPick(h.lat, h.lng, h.label.split(",").slice(0, 2).join(",")); }; });
    } catch (e) { if (mine === asked) list.innerHTML = `<li class="hint">${esc((e as Error).message)}</li>`; }
  };
  panel.querySelector("form")!.onsubmit = (e) => { e.preventDefault(); search(); };
  input.oninput = () => { clearTimeout(typing); typing = window.setTimeout(() => search(input.value.trim().length >= 2), 280); };
  panel.querySelector<HTMLButtonElement>("[data-pin-close]")!.onclick = () => close();
  if (o.extra) panel.querySelector<HTMLButtonElement>("[data-pin-extra]")!.onclick = () => { close(); o.extra!.onClick(); };
  // The map's own picking, from the start: a click there sets the spot instead of offering to add a place (Cancel or Esc
  // stops it; the search stays). The map stays where it is: they may already be looking at the right spot.
  const onMap = (at: { lat: number; lng: number }) => { close(); o.onPick(at.lat, at.lng, "the spot you clicked"); };
  if (mapModule.map) mapModule.pickOnMap(o.mapLabel, onMap, { scroll: false });
  // The panel gone some other way (the plan drawn again): the map stops waiting too.
  const gone = window.setInterval(() => { if (!panel.isConnected) { clearInterval(gone); mapModule.stopPicking(onMap); } }, 500);
  input.focus(); input.select();
  search();
  return panel;
  /** The panel goes, and the map stops waiting for a click. */
  function close() { panel.remove(); clearInterval(gone); mapModule.stopPicking(onMap); }
}

/** Draws the plan again with what `selector` names staying where it is on screen. (The new plan is laid out before its
 *  travel lines are filled in, which can leave the list scrolled further down than it was.) */
function keepingPlace(selector: string, draw: () => void) {
  const top = () => document.querySelector(selector)?.getBoundingClientRect().top;
  const was = top();
  draw();
  const now = top();
  if (was == null || now == null || Math.abs(now - was) < 1) return;
  // What scrolls it: its column, or (on a phone) the page.
  let box = document.querySelector(selector)!.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  (box || window).scrollBy({ top: now - was, behavior: "instant" });
}

/** Puts the stop where they said and redraws the plan and the map. */
function setAt(di: number, xi: number, lat: number, lng: number, label: string) {
  const x = state.itinerary?.days[di]?.items[xi];
  if (!x) return;
  x.lat = lat; x.lng = lng; x.pinned = true; delete x.fixed;
  save(); keepingPlace(`.item[data-k="${di}-${xi}"]`, renderItinerary); drawMap({ fit: false });
  toast(`${x.place}: set to ${label}`);
}

/** Opens the small "where is it?" panel under a stop. */
export function openPin(di: number, xi: number, anchor: HTMLElement) {
  const d = state.itinerary?.days[di], x = d?.items[xi], host = anchor.closest("li.item");
  if (!d || !x || !host) return;
  const here = itemLoc(x, d, byTitleMap()) || stayLoc(stayOn(d)!);
  // A transfer ("Rigi Kulm → Vitznau"): where it arrives, so the way on the map goes through there.
  const ends = transferEnds(x);
  wherePanel({
    host, near: here,
    title: ends ? `Where does it arrive in ${ends[1]}?` : `Where is ${x.place}?`,
    query: ends ? ends[1] : `${x.where || x.place}, ${d.city.split("/")[0].trim()}`,
    mapLabel: ends ? `where it arrives in ${ends[1]}` : x.place,
    onPick: (lat, lng, label) => setAt(di, xi, lat, lng, label),
  });
}
