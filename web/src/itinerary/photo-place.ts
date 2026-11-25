// Placing photos on the map by hand (Photos window → Place on map): the photos on the left, grouped by when they were
// taken, and a map on the right. A photo is clicked to look at it; photos are selected with the tick in their corner (or
// Ctrl/Shift+click, or a group's heading) and dragged onto the map, where they land at the point of the pin they're
// dragged as. Pictures on the map can be clicked (they open) and dragged somewhere else; dropped near another picture, a
// stop of the day or a search result, they take its exact spot. A group's suggestion (from the time) is used with one
// click. The list's filters and the map's (Layers) are separate. Photos with a location of their own are locked unless
// unlocked. The positions are kept with the trip (state.photoSpots); the files are never changed.
import { moveTo, moveToAll } from "../map/move";
import * as L from "leaflet";
import type { GeoHit } from "../../../shared/types";
import { esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { showGallery } from "../core/lightbox";
import { prefs } from "../core/prefs";
import { state } from "../core/state";
import { type Placed, allPhotos, folderOf, folders, isPhotosGuess, planDays, setPhotosGuess, setSpots, sourceOf, thumbTag, viewItem, when } from "../map/photos";
import { type PhotoSpot, burstsOf } from "../map/photo-spot";
import { placeSearch } from "../map/place-search";
import { isReadOnly } from "../saves/read-only";

export interface PlaceTool {
  /** The tool came on screen: the map takes its size, and starts where the photos are. */
  show: () => void;
  /** The photos changed. */
  update: () => void;
}

/** How far apart (screen pixels) pictures must be to be shown separately, and how near a drop snaps to a spot. */
const GRID = 60, SNAP = 18;
/** A photo pin: the picture with a point under it (the point is where it is). */
const PIN_W = 52, PIN_H = 64;
/** Photos with a location of their own can't be moved (on unless switched off). */
const LOCK_KEY = "trip-planner-photos-lock";
/** English place names on this map (unset: as Settings → General says for the main map). */
const ENGLISH_KEY = "trip-planner-photos-english";

type Which = "open" | "placed" | "skipped" | "all";
const WHICH: [Which, string, string][] = [
  ["open", "To place", "Photos without a location yet"], ["placed", "Placed", "Placed or moved by hand"],
  ["skipped", "Skipped", "Marked “can't place”"], ["all", "All", "Every photo"],
];

/** "where you took a photo 2 min before" stays; a stop's name is "near" it. */
const nearText = (near = "") => (/^where /.test(near) ? near : `near ${near}`);

/** A photo pin: the picture (with a count for several) and its point. */
const pinHtml = (first: Placed, n: number, cls: string, px = 128) =>
  `<div class="pp-pin ${cls}"><div class="photo-pin${n > 1 ? " many" : ""}">${thumbTag(first, px)}${n > 1 ? `<b>${n}</b>` : ""}</div></div>`;

export function placeTool(box: HTMLElement): PlaceTool {
  box.innerHTML = `<div class="pp-left">
      <div class="pp-top">
        <div class="pp-progress"><div><b data-pp-done></b><span data-pp-of></span></div>
          <button type="button" class="icon-btn" data-pp-undo title="Undo (Ctrl+Z)" aria-label="Undo">${icon("history")}</button></div>
        <div class="pp-bar"><i data-pp-bar></i></div>
        <div class="pp-which" role="tablist">${WHICH.map(([v, label, tip]) => `<button type="button" role="tab" data-pp-which="${v}" title="${tip}"><span>${label}</span><small data-pp-n="${v}"></small></button>`).join("")}</div>
        <div class="pp-filters">
          <select data-pp-day title="Only photos taken on this day"></select>
          <select data-pp-src title="Only photos from this folder"></select>
        </div>
      </div>
      <div class="pp-list"></div>
      <div class="pp-sel" hidden></div>
    </div>
    <div class="pp-right"><div class="pp-map"></div>
      <form class="pp-search"></form>
      <button type="button" class="pp-layers-btn" data-pp-layers-btn title="What the map shows">${icon("layers")}<span>Layers</span></button>
      <div class="pp-layers" hidden>
        <h5>On the map</h5>
        <select data-pp-mapday title="Only photos taken on this day (the list has its own filter)"></select>
        <label class="ph-check" title="Photos whose file has its own location"><input type="checkbox" data-pp-layer="camera" checked> Photos with location</label>
        <label class="ph-check"><input type="checkbox" data-pp-layer="placed" checked> Placed by hand</label>
        <label class="ph-check" title="The plan's stops of that day (or of the selected photos' day)"><input type="checkbox" data-pp-layer="stops" checked> The day's stops</label>
        <h5>Options</h5>
        <label class="ph-check" title="Photos whose file has its own location can't be moved. (Reset still puts a moved one back.)"><input type="checkbox" data-pp-lock> Lock photos with location</label>
        <label class="ph-check" title="Place names in English (Osaka Castle) instead of the local language and script"><input type="checkbox" data-pp-english> English place names</label>
      </div>
      <div class="pp-toast" role="status" hidden></div>
    </div>
    <div class="pp-ghost" aria-hidden="true"></div>`;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
  const list = q(".pp-list"), bar = q(".pp-sel"), daySel = q<HTMLSelectElement>("[data-pp-day]"), srcSel = q<HTMLSelectElement>("[data-pp-src]");
  const mapDay = q<HTMLSelectElement>("[data-pp-mapday]"), ghost = q(".pp-ghost"), toastEl = q(".pp-toast");
  const layerOn = (name: string) => q<HTMLInputElement>(`[data-pp-layer="${name}"]`).checked;

  let m: L.Map | null = null, pins: L.LayerGroup, stops: L.LayerGroup, found: L.LayerGroup;
  let photos: Placed[] = [], byKey = new Map<string, Placed>();
  let which: Which = "open";
  const selected = new Set<string>();
  /** The photos of the picture clicked on the map, or just placed: listed on top (they may not pass the filters). */
  let atSpot: string[] = [];
  /** The tiles in the order listed (Shift+click selects a range), and the groups listed. */
  let order: string[] = [], anchor = "", groups: Placed[][] = [];
  let history: Record<string, PhotoSpot | null>[] = [], trip = "";
  /** Something is being dragged: nothing is redrawn under the pointer. */
  let dragging = false, dragged: string[] = [];
  /** Each photo's pin on the map, to light it up while its tile is pointed at. */
  let pinOf = new Map<string, HTMLElement>();

  /** The list's filters (the map has its own). */
  const passes = (p: Placed) => (!daySel.value || (p.t.slice(0, 10) || "none") === daySel.value) && (!srcSel.value || p.folder === srcSel.value);
  const isWhich = (p: Placed, w: Which) => w === "all" || (w === "open" && !p.camera && !p.placed && !p.skipped) || (w === "placed" && !!p.placed) || (w === "skipped" && !!p.skipped);
  const listed = (p: Placed) => passes(p) && isWhich(p, which);
  const chosen = () => [...selected].map((k) => byKey.get(k)).filter((p): p is Placed => !!p);
  const lock = q<HTMLInputElement>("[data-pp-lock]");
  lock.checked = localStorage.getItem(LOCK_KEY) !== "0";
  const locked = (p: Placed | undefined) => !!p?.camera && lock.checked;
  /** Nowhere yet (a suggestion isn't a place): what a click on the map places. Others are moved by dragging, so a click
   *  doesn't move a photo by accident. */
  const unplaced = (p: Placed) => !p.camera && !p.placed;
  const canDrag = (p: Placed) => !isReadOnly() && !locked(p);
  const plural = (n: number, word = "photo") => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  // ---- A short note at the bottom of the map, with Undo ----
  let toastTimer = 0;
  function say(text: string, undoable = true) {
    toastEl.innerHTML = `<span>${esc(text)}</span>${undoable && history.length ? `<button type="button" data-pp-toast-undo>Undo</button>` : ""}`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 6000);
  }
  toastEl.onclick = (e) => { if ((e.target as HTMLElement).closest("[data-pp-toast-undo]")) { toastEl.hidden = true; undo(); } };

  // ---- Changing spots ----
  /** Records the changes (locked photos left out; a Reset is always allowed); false when nothing changed. */
  function change(changes: Record<string, PhotoSpot | null>): boolean {
    if (isReadOnly()) { say("This trip is view only. Make your own copy to place photos.", false); return false; }
    changes = Object.fromEntries(Object.entries(changes).filter(([k, spot]) => !spot || !locked(byKey.get(k))));
    if (!Object.keys(changes).length) return false;
    history.push(setSpots(changes));
    return true;
  }
  const at = (ll: L.LatLng): PhotoSpot => { const w = ll.wrap(); return { lat: +Math.max(-90, Math.min(90, w.lat)).toFixed(6), lng: +w.lng.toFixed(6) }; };
  /** Photos just placed or moved stay selected and listed on top, so they can be reset or looked at. */
  function keep(keys: string[]) {
    atSpot = keys;
    selected.clear();
    for (const k of keys) selected.add(k);
    anchor = keys[0] || "";
    draw();
    list.scrollTop = 0;
  }
  function put(keys: string[], ll: L.LatLng) {
    const free = keys.filter((k) => !locked(byKey.get(k)));
    if (!free.length) return say("Locked: these have a location of their own. Untick “Lock photos with location” under Layers to move them.", false);
    const moved = free.some((k) => byKey.get(k)?.lat != null && !byKey.get(k)?.guessed);
    if (!change(Object.fromEntries(free.map((k) => [k, at(ll)])))) return;
    keep(free);
    say(`${moved ? "Moved" : "Placed"} ${plural(free.length)}`);
  }
  /** A click on the map, a stop or a search result: the selected photos that are nowhere yet go there. */
  function clicked(ll: L.LatLng) {
    const keys = chosen().filter(unplaced).map((p) => p.key);
    if (keys.length) put(keys, ll);
    else if (selected.size) clearSel();
  }
  function undo() {
    const last = history.pop();
    if (!last) return;
    setSpots(last);
    draw();
    say("Undone", false);
  }
  /** Photos go where their time suggests; the next group is then selected, to go through them quickly. */
  function accept(take: Placed[]) {
    take = take.filter((p) => p.guessed && unplaced(p));
    if (!take.length) return;
    // What was listed after them, taken before the list changes.
    const after = new Set(order.slice(order.indexOf(take[take.length - 1].key) + 1));
    if (!change(Object.fromEntries(take.map((p) => [p.key, { lat: p.lat!, lng: p.lng! }])))) return;
    selected.clear(); atSpot = [];
    say(`Placed ${plural(take.length)} where the time suggests`);
    const next = which === "open" ? groups.find((g) => g.some((p) => after.has(p.key) && unplaced(p))) : undefined;
    if (next) {
      draw();
      select(next.map((p) => p.key), true);
      list.querySelector(".pp-tile.sel")?.closest(".pp-group")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else draw();
  }
  function skip() {
    const keys = chosen().filter((p) => !p.skipped).map((p) => p.key);
    if (!change(Object.fromEntries(keys.map((k) => [k, { skip: true as const }])))) return;
    selected.clear(); atSpot = [];
    draw();
    say(`Marked ${plural(keys.length)} as can't place`);
  }
  function reset() {
    const keys = chosen().filter((p) => p.placed || p.skipped).map((p) => p.key);
    if (!change(Object.fromEntries(keys.map((k) => [k, null])))) return;
    draw();
    say(`Reset ${plural(keys.length)}`);
  }

  // ---- Selecting ----
  /** Selects these photos; `fly` moves the map to where they are (or are suggested to be). */
  function select(keys: string[], fly = false) {
    selected.clear();
    for (const k of keys) selected.add(k);
    anchor = keys[0] || "";
    marks(); drawMap();
    if (fly) flyToSelection();
  }
  function toggle(key: string) {
    const was = selected.size;
    if (!selected.delete(key)) selected.add(key);
    anchor = key;
    marks(); drawMap();
    if (!was && selected.size) flyToSelection();
  }
  function clearSel() { selected.clear(); atSpot = []; draw(); }
  function flyToSelection() {
    if (!m) return;
    const spots = chosen().filter((p) => p.lat != null).map((p) => L.latLng(p.lat!, p.lng!));
    // Without a spot of their own, the day's stops.
    const around = spots.length ? spots : dayStops().map((s) => L.latLng(s.lat, s.lng));
    moveToAll(m, around, 16, L);
  }

  /** The selection's look, the bar under the list and the counts, without drawing the list again. */
  function marks() {
    list.classList.toggle("picking", selected.size > 0);
    for (const el of list.querySelectorAll<HTMLElement>(".pp-tile")) el.classList.toggle("sel", selected.has(el.dataset.key!));
    for (const el of list.querySelectorAll<HTMLElement>(".pp-group")) {
      const keys = [...el.querySelectorAll<HTMLElement>(".pp-tile")].map((t) => t.dataset.key!);
      el.classList.toggle("all", keys.length > 0 && keys.every((k) => selected.has(k)));
    }
    q<HTMLButtonElement>("[data-pp-undo]").disabled = !history.length;
    // A click on the map places the selected photos that are nowhere yet: it says so with a crosshair.
    m?.getContainer().classList.toggle("aim", chosen().some(unplaced) && !isReadOnly());
    drawTop(); drawSel();
  }

  function drawTop() {
    const need = photos.filter((p) => !p.camera), done = need.filter((p) => p.placed).length, skipped = need.filter((p) => p.skipped).length;
    q("[data-pp-done]").textContent = !photos.length ? "No photos yet" : !need.length ? "Every photo has a location" : `${done.toLocaleString()} of ${need.length.toLocaleString()} placed`;
    q("[data-pp-of]").textContent = need.length && skipped ? ` · ${skipped.toLocaleString()} skipped` : "";
    q("[data-pp-bar]").style.width = `${need.length ? Math.round(((done + skipped) / need.length) * 100) : 100}%`;
    for (const [w] of WHICH) {
      q(`[data-pp-n="${w}"]`).textContent = photos.filter((p) => passes(p) && isWhich(p, w)).length.toLocaleString();
      q(`[data-pp-which="${w}"]`).classList.toggle("on", w === which);
    }
  }

  /** The bar under the list: what's selected, what can be done with it, and its suggestion (or why there's none). */
  function drawSel() {
    const sel = chosen();
    bar.hidden = !sel.length;
    if (!sel.length) return;
    const ro = isReadOnly(), guesses = sel.filter((p) => p.guessed && unplaced(p)), open = sel.filter(unplaced);
    const hint = ro ? "This trip is view only. Make your own copy to place photos."
      : sel.every(locked) ? "These have a location of their own and are locked (Layers → Lock photos with location)."
        : open.length ? "Drag them onto the map, or click the spot." : "Drag their pin on the map to move them.";
    const why = ro || !open.length || guesses.length ? ""
      : !isPhotosGuess() ? `Suggestions from the photos' time are off. <button type="button" class="link-btn" data-pp-guess>Turn them on</button>`
        : open.every((p) => !p.t) ? "No suggestion: these photos have no time."
          : "No suggestion: nothing with a location was taken within 45 minutes of these, and the plan has no stop with a time that day.";
    const canSkip = !ro && sel.some((p) => !p.skipped && !locked(p)), canReset = !ro && sel.some((p) => p.placed || p.skipped);
    bar.innerHTML = `<div class="pp-sel-head"><b>${plural(sel.length)} selected</b><button type="button" class="link-btn" data-pp-clear>Clear</button></div>
      <p class="hint">${hint}</p>
      ${guesses.length && !ro ? `<button type="button" class="btn solid pp-use" data-pp-accept title="Put them where their time suggests">${icon("sparkles")}<span>Use suggestion<small>${esc(nearText(guesses[0].near))}</small></span><kbd>Enter</kbd></button>` : ""}
      ${why ? `<p class="hint pp-why">${why}</p>` : ""}
      ${canSkip || canReset ? `<div class="pp-sel-acts">${canSkip ? `<button type="button" class="btn" data-pp-skip title="Leave them out: they're not listed under To place, and get no suggestion">Can't place</button>` : ""}${canReset ? `<button type="button" class="btn" data-pp-reset title="Take back the spot given by hand: the photo has its camera's location again, or none">Reset</button>` : ""}</div>` : ""}`;
  }
  bar.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-pp-clear]")) clearSel();
    else if (t.closest("[data-pp-accept]")) accept(chosen());
    else if (t.closest("[data-pp-skip]")) skip();
    else if (t.closest("[data-pp-reset]")) reset();
    else if (t.closest("[data-pp-guess]")) setPhotosGuess(true);
  };

  // ---- The list ----
  const tile = (p: Placed) => {
    order.push(p.key);
    const badge = p.placed ? "placed" : p.skipped ? "can't place" : p.camera && which !== "open" ? "GPS" : "";
    return `<div class="pp-tile${selected.has(p.key) ? " sel" : ""}" draggable="${canDrag(p)}" data-key="${esc(p.key)}" title="${esc([p.name, when(p.t), sourceOf(p)].filter(Boolean).join(" · "))}">${thumbTag(p, 160, 'loading="lazy" decoding="async"')}<button type="button" class="pp-check" data-pp-pick title="Select (or Ctrl+click the photo)" aria-label="Select">${icon("check")}</button>${p.video ? `<span class="pp-vid">${icon("play")}</span>` : ""}${badge ? `<i>${badge}</i>` : ""}</div>`;
  };
  /** The folders a group's photos are from, and who uploaded them. */
  const from = (g: Placed[]) => [...new Set(g.map(sourceOf))].map(esc).join(" · ");
  const heading = (g: Placed[]) => {
    const a = g[0].t, b = g[g.length - 1].t, clock = (t: string) => t.slice(11, 16);
    return a ? `${fmtDate(a.slice(0, 10)) || a.slice(0, 10)} · ${clock(a)}${clock(b) !== clock(a) ? `–${clock(b)}` : ""}` : "No time";
  };
  const section = (g: Placed[], i: number, title: string, extra = "") => {
    const guess = !isReadOnly() && g.find((p) => p.guessed && unplaced(p));
    return `<section class="pp-group${extra ? " pp-spot" : ""}" data-g="${i}">
      <header draggable="${g.some(canDrag)}" title="Click to select them all; drag to place them together">
        <span class="pp-check" aria-hidden="true">${icon("check")}</span>
        <div class="pp-gh"><b>${esc(title)}</b><small>${from(g)}</small></div><em>${g.length}</em>${extra}</header>
      ${guess ? `<button type="button" class="pp-sugg" data-pp-use title="Put them where their time suggests">${icon("sparkles")}<span>Suggested: ${esc(nearText(guess.near))}</span><u>Use</u></button>` : ""}
      <div class="pp-grid">${g.map(tile).join("")}</div></section>`;
  };
  function drawList() {
    const top = list.scrollTop;
    order = [];
    const spot = atSpot.map((k) => byKey.get(k)).filter((p): p is Placed => !!p), inSpot = new Set(spot.map((p) => p.key));
    groups = burstsOf(photos.filter((p) => listed(p) && !inSpot.has(p.key)));
    const here = spot.length ? section(spot, -1, "At this spot", `<button type="button" class="icon-btn" data-pp-close title="Close">${icon("x")}</button>`) : "";
    const empty = !folders().length ? "No photo folders yet. Add one in the Gallery."
      : !photos.length ? "Loading the photos…"
        : which === "open" && !photos.some((p) => passes(p) && isWhich(p, "open")) ? "Nothing left to place here. 🎉"
          : "No photos match.";
    list.innerHTML = here + (groups.length ? groups.map((g, i) => section(g, i, heading(g))).join("") : here ? "" : `<p class="ph-empty">${empty}</p>`);
    list.scrollTop = top;
  }
  const groupAt = (el: Element) => { const i = +(el.closest<HTMLElement>(".pp-group")?.dataset.g ?? NaN); return i === -1 ? atSpot.map((k) => byKey.get(k)!).filter(Boolean) : groups[i] || []; };

  function drawFilters() {
    const dates = [...new Set(photos.map((p) => p.t.slice(0, 10) || "none"))].sort();
    const days = state.itinerary?.days || [];
    const dayItems = dates.map((d): [string, string] => {
      const i = days.findIndex((x) => x.date === d);
      return [d, d === "none" ? "No time" : `${i >= 0 ? `Day ${i + 1} · ` : ""}${fmtDate(d) || d}`];
    });
    const opts = (all: string, items: [string, string][], now: string) => `<option value="">${all}</option>${items.map(([v, label]) => `<option value="${esc(v)}"${v === now ? " selected" : ""}>${esc(label)}</option>`).join("")}`;
    daySel.innerHTML = opts("All days", dayItems, daySel.value);
    mapDay.innerHTML = opts("Every day", dayItems, mapDay.value);
    srcSel.innerHTML = opts("All folders", [...new Map(photos.map((p) => [p.folder, folderOf({ ...p, dir: undefined })]))], srcSel.value);
  }

  // ---- The map ----
  /** The stops of the day on show: the map's filter's, else the selected photos'. */
  function dayStops() {
    const date = mapDay.value || chosen()[0]?.t.slice(0, 10) || "";
    const d = date ? planDays().find((x) => x.date === date) : undefined;
    return d ? [...d.stops, ...(d.home ? [d.home] : [])] : [];
  }
  /** The spot a drop near a stop, a search result or a picture snaps to. */
  function snap(ll: L.LatLng, skip?: L.Marker): L.LatLng {
    if (!m) return ll;
    const here = m.latLngToContainerPoint(ll);
    let best = ll, dist = SNAP;
    for (const group of [stops, found, pins]) group.eachLayer((l) => {
      if (l === skip || !(l instanceof L.Marker)) return;
      const d = m!.latLngToContainerPoint(l.getLatLng()).distanceTo(here);
      if (d < dist) { dist = d; best = l.getLatLng(); }
    });
    return best;
  }
  const onMapDay = (p: Placed) => !mapDay.value || (p.t.slice(0, 10) || "none") === mapDay.value;

  function drawMap() {
    if (!m || dragging) return;
    pins.clearLayers(); stops.clearLayers(); pinOf = new Map();
    if (layerOn("stops")) for (const s of dayStops()) {
      L.marker([s.lat, s.lng], { keyboard: false, zIndexOffset: -500, icon: L.divIcon({ className: "", html: `<div class="pp-stop"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) })
        .bindTooltip(esc(s.name), { direction: "top", offset: [0, -8] })
        .on("click", () => clicked(L.latLng(s.lat, s.lng)))
        .addTo(stops);
    }
    // The map's own filters; the selected photos always (a suggestion only for them: it sits exactly on the picture it's
    // taken from, and would cover it).
    const visible = photos.filter((p) => p.lat != null && (selected.has(p.key) || (!p.guessed && onMapDay(p) && layerOn(p.placed ? "placed" : "camera"))));
    const b = m.getBounds().pad(0.3), z = m.getZoom();
    const cells = new Map<string, Placed[]>();
    for (const p of visible) {
      if (!b.contains([p.lat!, p.lng!])) continue;
      const pt = m.project([p.lat!, p.lng!], z);
      // Suggestions and locked photos are grouped apart: dragging a group must not take them along by accident.
      const key = `${Math.floor(pt.x / GRID)}_${Math.floor(pt.y / GRID)}_${p.guessed ? "g" : locked(p) ? "l" : "r"}`;
      cells.set(key, [...(cells.get(key) || []), p]);
    }
    for (const group of cells.values()) {
      const n = group.length, first = group.find((p) => selected.has(p.key)) || group[0], sel = group.some((p) => selected.has(p.key));
      const lat = group.reduce((s, p) => s + p.lat!, 0) / n, lng = group.reduce((s, p) => s + p.lng!, 0) / n;
      const guess = first.guessed, lockedHere = group.some(locked);
      const cls = [guess ? "guess" : "", group.every((p) => p.placed) ? "placed" : "", sel ? "sel" : "", lockedHere ? "locked" : ""].join(" ");
      const what = n > 1 ? `${n} photos<br><span class="pop-meta">${[...new Set(group.map(folderOf))].map(esc).join(", ")}</span>`
        : `${esc(first.name)}<br><span class="pop-meta">${esc(when(first.t))}<br>${esc(sourceOf(first))}</span>`;
      const how = guess ? "Suggested from the time · click to use it, or drag it to the right spot" : lockedHere ? "Click to open · locked" : "Click to open · drag to move";
      const mk = L.marker([lat, lng], {
        pane: "photos", zIndexOffset: sel ? 1000 : 0, draggable: !isReadOnly() && !lockedHere, autoPan: true,
        icon: L.divIcon({ className: "", html: pinHtml(first, n, cls), iconSize: [PIN_W, PIN_H], iconAnchor: [PIN_W / 2, PIN_H] }),
      }).bindTooltip(`<div class="pp-tip">${thumbTag(first, 320)}${what}<br><span class="pop-meta">${how}</span></div>`, { direction: "top", offset: [0, -PIN_H - 4] })
        .addTo(pins);
      const el = mk.getElement();
      if (el) for (const p of group) pinOf.set(p.key, el);
      mk.on("click", () => {
        mk.closeTooltip();
        // A suggestion is taken with a click.
        if (guess) return accept(group);
        // Others open full screen (going through the others here); they're selected and listed when it's closed.
        const items = [...group].sort((a, b) => a.t.localeCompare(b.t));
        keep(items.map((p) => p.key));
        showGallery(items.map(viewItem), items.indexOf(first));
      });
      mk.on("dragstart", () => { dragging = true; mk.closeTooltip(); });
      mk.on("dragend", () => {
        dragging = false;
        const to = snap(mk.getLatLng(), mk), dLat = to.lat - lat, dLng = to.lng - lng;
        // A group moves as it lies: each photo by the same distance (one spot stays one spot).
        if (!change(Object.fromEntries(group.map((p) => [p.key, at(L.latLng(p.lat! + dLat, p.lng! + dLng))])))) return draw();
        keep(group.map((p) => p.key));
        say(`${guess ? "Placed" : "Moved"} ${plural(n)}`);
      });
    }
  }

  // ---- The map's names ----
  const english = q<HTMLInputElement>("[data-pp-english]");
  english.checked = (localStorage.getItem(ENGLISH_KEY) ?? (prefs.app.mapNames === "english" ? "1" : "0")) === "1";
  let base: L.Layer | null = null;
  async function setBase() {
    if (!m) return;
    const wanted = english.checked;
    let next: L.Layer;
    try {
      next = wanted
        ? (await import("../map/english-map")).englishLayer((why) => { say(why, false); english.checked = false; setBase(); })
        : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
    } catch (e) {
      // (Back to the local names, and the reason why.)
      say((e as Error).message, false);
      english.checked = false;
      if (!base) setBase();
      return;
    }
    if (wanted !== english.checked) return; // switched again while loading
    base?.remove();
    base = next.addTo(m);
  }

  // ---- The search (place-search.ts) ----
  /** The map goes to a search result and marks it: photos can be dropped on the mark (or the selected placed with a click). */
  function goTo(r: GeoHit) {
    if (!m) return;
    for (const l of [...found.getLayers()]) if (!(l as L.Marker & { psArea?: boolean }).psArea) found.removeLayer(l);
    L.marker([r.lat, r.lng], { zIndexOffset: -400, icon: L.divIcon({ className: "", html: `<div class="pp-found">${icon("pin")}</div>`, iconSize: [32, 32], iconAnchor: [16, 30] }) })
      .bindTooltip(esc(r.name), { direction: "top", offset: [0, -30], permanent: true, className: "pp-found-tip" })
      .on("click", () => clicked(L.latLng(r.lat, r.lng)))
      .addTo(found);
    moveTo(m, [r.lat, r.lng], 17);
  }
  const searchBar = placeSearch(q<HTMLFormElement>(".pp-search"), { map: () => m, placeholder: "Search places, streets, stations", onPick: goTo, onClear: () => found?.clearLayers(), layer: () => found });

  // ---- Layers ----
  const layersBox = q(".pp-layers"), layersBtn = q<HTMLButtonElement>("[data-pp-layers-btn]");
  layersBtn.onclick = () => { layersBox.hidden = !layersBox.hidden; layersBtn.classList.toggle("on", !layersBox.hidden); };
  box.addEventListener("pointerdown", (e) => {
    if (!layersBox.hidden && !(e.target as HTMLElement).closest(".pp-layers, [data-pp-layers-btn]")) { layersBox.hidden = true; layersBtn.classList.remove("on"); }
  });

  function makeMap() {
    m = L.map(q(".pp-map"), { worldCopyJump: true, zoomControl: false }).setView([30, 10], 2);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    setBase();
    // Their own pane, as on the main map: in Leaflet's marker pane its styles size pictures to their own shape.
    m.createPane("photos").style.zIndex = "620";
    stops = L.layerGroup().addTo(m); found = L.layerGroup().addTo(m); pins = L.layerGroup().addTo(m);
    m.on("moveend", drawMap);
    m.on("click", (e) => clicked(snap(e.latlng)));
    // Photos dragged from the list: they land where the point of the pin they're dragged as is.
    const el = m.getContainer();
    el.addEventListener("dragover", (e) => { if (dragged.length) { e.preventDefault(); e.dataTransfer!.dropEffect = "move"; el.classList.add("over"); } });
    el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove("over"); });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("over");
      const keys = dragged;
      dragged = []; dragging = false;
      if (keys.length) put(keys, snap(m!.mouseEventToLatLng(e)));
    });
  }

  const draw = () => { if (dragging) return; drawList(); marks(); drawMap(); };

  function update() {
    if (dragging) return;
    // Another trip: its own history and selection.
    const now = state.saveName || "";
    if (now !== trip) { trip = now; history = []; selected.clear(); atSpot = []; searchBar.clear(); }
    photos = allPhotos();
    byKey = new Map(photos.map((p) => [p.key, p]));
    for (const k of selected) if (!byKey.has(k)) selected.delete(k);
    atSpot = atSpot.filter((k) => byKey.has(k));
    drawFilters();
    draw();
  }

  // ---- What the list does ----
  /** A photo full screen, going on through the others as listed. */
  const view = (key: string) => showGallery(order.map((k) => viewItem(byKey.get(k)!)), order.indexOf(key));
  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-pp-close]")) { atSpot = []; selected.clear(); return draw(); }
    if (target.closest("[data-pp-use]")) return accept(groupAt(target));
    const el = target.closest<HTMLElement>(".pp-tile");
    if (el) {
      const key = el.dataset.key!;
      if (target.closest("[data-pp-pick]") || e.ctrlKey || e.metaKey) return toggle(key);
      if (e.shiftKey && anchor) {
        const a = order.indexOf(anchor), z = order.indexOf(key);
        if (a >= 0) { const was = anchor; select(order.slice(Math.min(a, z), Math.max(a, z) + 1)); anchor = was; return; }
      }
      return view(key);
    }
    if (target.closest("header")) {
      const keys = groupAt(target).map((p) => p.key);
      // A group all selected already: its heading takes them off again.
      if (keys.every((k) => selected.has(k))) { for (const k of keys) selected.delete(k); marks(); drawMap(); }
      else select(keys, true);
    }
  });
  // The photo pointed at in the list lights up its pin on the map.
  list.addEventListener("mouseover", (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>(".pp-tile")?.dataset.key;
    for (const el of box.querySelectorAll(".pp-map .hot")) el.classList.remove("hot");
    if (key) pinOf.get(key)?.querySelector(".pp-pin")?.classList.add("hot");
  });
  list.addEventListener("mouseleave", () => { for (const el of box.querySelectorAll(".pp-map .hot")) el.classList.remove("hot"); });
  list.addEventListener("dragstart", (e) => {
    const target = e.target as HTMLElement, el = target.closest<HTMLElement>(".pp-tile");
    // A selected photo takes the whole selection along; a heading, its group.
    const keys = el ? (selected.has(el.dataset.key!) ? [...selected] : [el.dataset.key!]) : groupAt(target).map((p) => p.key);
    dragged = keys.filter((k) => canDrag(byKey.get(k)!));
    if (!dragged.length) { e.preventDefault(); return; }
    dragging = true;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", plural(dragged.length));
    // Dragged as a pin: it lands where its point is.
    const first = byKey.get(el && dragged.includes(el.dataset.key!) ? el.dataset.key! : dragged[0])!;
    ghost.innerHTML = pinHtml(first, dragged.length, "drag", 160);
    // (The ghost has room around the pin for the count's badge.)
    e.dataTransfer!.setDragImage(ghost, 12 + PIN_W / 2, 12 + PIN_H);
  });
  list.addEventListener("dragend", () => { dragged = []; dragging = false; q(".pp-map").classList.remove("over"); update(); });

  // ---- Filters, layers, keys ----
  for (const b of box.querySelectorAll<HTMLButtonElement>("[data-pp-which]")) b.onclick = () => { which = b.dataset.ppWhich as Which; selected.clear(); atSpot = []; list.scrollTop = 0; draw(); };
  for (const s of [daySel, srcSel]) s.onchange = () => { selected.clear(); atSpot = []; list.scrollTop = 0; draw(); };
  mapDay.onchange = () => { drawMap(); fit(); };
  for (const c of box.querySelectorAll<HTMLInputElement>("[data-pp-layer]")) c.onchange = () => drawMap();
  lock.onchange = () => { localStorage.setItem(LOCK_KEY, lock.checked ? "1" : "0"); draw(); };
  english.onchange = () => { localStorage.setItem(ENGLISH_KEY, english.checked ? "1" : "0"); setBase(); };
  q<HTMLButtonElement>("[data-pp-undo]").onclick = undo;
  const dialog = box.closest("dialog")!;
  /** The keys are the tool's while it's on screen and no other window (or a photo full screen) is over it. They're
   *  listened for on the page: the focus may be nowhere (after a button it was on went away). */
  const mine = () => !!box.offsetParent && [...document.querySelectorAll("dialog[open]")].pop() === dialog && !document.querySelector(".lightbox");
  document.addEventListener("keydown", (e) => {
    if (!mine() || (e.target as HTMLElement).closest("select, input, textarea")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    else if (e.key === "Enter" && !(e.target as HTMLElement).closest("button")) { e.preventDefault(); accept(chosen()); }
  });
  // Esc lets go of the selection first; the next one closes the window. (On the key itself: Chrome lets a window's
  // "cancel" be stopped only once in a row.) Not while a photo is open full screen, or in the search, which has its own.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !mine() || !selected.size || (e.target as HTMLElement).closest(".pp-search")) return;
    e.preventDefault(); e.stopPropagation();
    clearSel();
  }, true);

  /** The map goes to the photos the map shows that have a location (else the plan's stops). */
  function fit() {
    if (!m) return;
    const pts = photos.filter((p) => onMapDay(p) && p.lat != null && !p.guessed).map((p) => L.latLng(p.lat!, p.lng!));
    const around = pts.length ? pts : planDays().filter((d) => !mapDay.value || d.date === mapDay.value).flatMap((d) => d.stops.map((s) => L.latLng(s.lat, s.lng)));
    if (around.length) m.fitBounds(L.latLngBounds(around).pad(0.15), { maxZoom: 16, animate: false });
  }

  let fitted = "";
  return {
    update,
    show() {
      const first = !m;
      if (first) makeMap();
      update();
      // The map's box has its size only now that it's on screen.
      requestAnimationFrame(() => {
        m!.invalidateSize();
        // Once per trip, once there's something to look at; afterwards the map stays where it was left.
        if ((first || fitted !== trip) && photos.length) { fit(); fitted = trip; }
        drawMap();
      });
    },
  };
}
