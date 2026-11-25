// Placing photos on the map by hand (Photos window → Place on map): the photos on the left, grouped by when they were
// taken, and a map on the right. Photos are dragged onto the map (or selected, then the map clicked), and every picture
// on the map can be clicked (it opens) and dragged somewhere else. Dropped near another picture or one of the day's
// stops, they take its exact spot. Photos with a location of their own are locked unless unlocked. The positions are
// kept with the trip (state.photoSpots); the files are never changed.
import * as L from "leaflet";
import { esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { showGallery } from "../core/lightbox";
import { state } from "../core/state";
import { type Placed, allPhotos, folderOf, folders, isPhotosGuess, planDays, setSpots, sourceOf, thumbTag, viewItem, when } from "../map/photos";
import { type PhotoSpot, burstsOf } from "../map/photo-spot";
import { isReadOnly } from "../saves/read-only";

export interface PlaceTool {
  /** The tool came on screen: the map takes its size, and starts where the photos are. */
  show: () => void;
  /** The photos changed. */
  update: () => void;
}

/** How far apart (screen pixels) pictures must be to be shown separately, and how near a drop snaps to a spot. */
const GRID = 56, SNAP = 18;
/** Photos with a location of their own can't be moved (on unless switched off). */
const LOCK_KEY = "trip-planner-photos-lock";

export function placeTool(box: HTMLElement): PlaceTool {
  box.innerHTML = `<div class="pp-left">
      <div class="pp-filters">
        <select data-pp-which title="Which photos are listed"><option value="open">Without a location</option><option value="placed">Placed by hand</option><option value="skipped">Can't place</option><option value="all">All photos</option></select>
        <select data-pp-day title="The day they were taken"></select>
        <select data-pp-src title="The folder they're from"></select>
      </div>
      <div class="pp-acts">
        <button type="button" class="btn solid" data-pp-accept title="Put the selected photos where their time suggests (Enter)">${icon("check")} Accept suggestion</button>
        <button type="button" class="btn" data-pp-skip>Can't place</button>
        <button type="button" class="btn" data-pp-reset title="Take back the spot given by hand: the photo has its camera's position again, or none">Reset</button>
        <button type="button" class="btn" data-pp-undo title="Undo the last change (Ctrl+Z)">${icon("history")} Undo</button>
      </div>
      <p class="hint pp-info" data-pp-info></p>
      <div class="pp-list"></div>
    </div>
    <div class="pp-right"><div class="pp-map"></div>
      <div class="pp-layers">
        <label class="ph-check" title="Photos whose file has its own position"><input type="checkbox" data-pp-layer="camera" checked> With location</label>
        <label class="ph-check"><input type="checkbox" data-pp-layer="placed" checked> Placed by hand</label>
        <label class="ph-check" title="Where the time suggests the selected photos were taken, drawn with a dashed border"><input type="checkbox" data-pp-layer="guess" checked> Suggestions</label>
        <label class="ph-check" title="The plan's stops of the day (of the selected photos)"><input type="checkbox" data-pp-layer="stops" checked> Day's stops</label>
        <label class="ph-check pp-lock" title="Photos whose file has its own location can't be moved. (Reset still puts a moved one back.)"><input type="checkbox" data-pp-lock> Lock photos with location</label>
      </div>
    </div>`;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
  const list = q(".pp-list"), which = q<HTMLSelectElement>("[data-pp-which]"), daySel = q<HTMLSelectElement>("[data-pp-day]"), srcSel = q<HTMLSelectElement>("[data-pp-src]");
  const layerOn = (name: string) => q<HTMLInputElement>(`[data-pp-layer="${name}"]`).checked;

  let m: L.Map | null = null, pins: L.LayerGroup, stops: L.LayerGroup;
  let photos: Placed[] = [], byKey = new Map<string, Placed>();
  const selected = new Set<string>();
  /** The photos of the picture clicked on the map, listed on top (they may not pass the filters). */
  let atSpot: string[] = [];
  /** The tiles in the order listed, for selecting a range with Shift. */
  let order: string[] = [], anchor = "";
  let history: Record<string, PhotoSpot | null>[] = [], trip = "";
  /** Something is being dragged: nothing is redrawn under the pointer. */
  let dragging = false, dragged: string[] = [];

  const passes = (p: Placed) => {
    if (daySel.value && (p.t.slice(0, 10) || "none") !== daySel.value) return false;
    return !srcSel.value || p.folder === srcSel.value;
  };
  const listed = (p: Placed) => passes(p) && (which.value === "all" || (which.value === "open" && !p.camera && !p.placed && !p.skipped)
    || (which.value === "placed" && !!p.placed) || (which.value === "skipped" && !!p.skipped));
  const chosen = () => [...selected].map((k) => byKey.get(k)).filter((p): p is Placed => !!p);
  const lock = q<HTMLInputElement>("[data-pp-lock]");
  lock.checked = localStorage.getItem(LOCK_KEY) !== "0";
  const locked = (p: Placed | undefined) => !!p?.camera && lock.checked;
  /** Nowhere yet (a suggestion isn't a place): what a click on the map places. Others are moved by dragging, so a click
   *  doesn't move a photo by accident. */
  const unplaced = (p: Placed) => !p.camera && !p.placed;

  // ---- Changing spots ----
  function change(changes: Record<string, PhotoSpot | null>) {
    // A locked photo takes no new spot; taking one back (Reset) is always allowed.
    changes = Object.fromEntries(Object.entries(changes).filter(([k, spot]) => !spot || !locked(byKey.get(k))));
    if (!Object.keys(changes).length) return;
    if (isReadOnly()) { info("This trip is view only. Make your own copy to place photos."); return; }
    history.push(setSpots(changes));
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
    if (!free.length) return info("Locked: these have a location of their own. Untick “Lock photos with location” to move them.");
    const spot = at(ll);
    change(Object.fromEntries(free.map((k) => [k, spot])));
    keep(free);
  }
  /** A click on the map or on a stop: the selected photos that are nowhere yet go there. */
  function clicked(ll: L.LatLng) {
    const keys = chosen().filter(unplaced).map((p) => p.key);
    if (keys.length) put(keys, ll);
    else if (selected.size) { selected.clear(); atSpot = []; draw(); }
  }
  function undo() {
    const last = history.pop();
    if (last) { setSpots(last); draw(); }
  }
  /** The selected photos go where their time suggests; the next group is then selected, to go through them quickly. */
  function accept() {
    const take = chosen().filter((p) => p.guessed);
    if (!take.length) return;
    // What was listed after them, taken before the list changes.
    const after = new Set(order.slice(order.indexOf(take[0].key) + 1));
    selected.clear(); atSpot = [];
    change(Object.fromEntries(take.map((p) => [p.key, { lat: p.lat!, lng: p.lng! }])));
    if (which.value !== "open") return draw();
    const next = burstsOf(photos.filter(listed)).find((g) => g.some((p) => after.has(p.key)));
    if (next) select(next.map((p) => p.key), true); else draw();
    list.querySelector(".pp-tile.sel")?.scrollIntoView({ block: "nearest" });
  }

  // ---- Selecting ----
  /** Selects these photos; `fly` moves the map to where they are (or are suggested to be). */
  function select(keys: string[], fly = false) {
    selected.clear();
    for (const k of keys) selected.add(k);
    anchor = keys[0] || "";
    marks(); drawMap();
    if (!fly || !m) return;
    const spots = chosen().filter((p) => p.lat != null).map((p) => L.latLng(p.lat!, p.lng!));
    // Without a spot of their own, the day's stops.
    const around = spots.length ? spots : dayStops().map((s) => L.latLng(s.lat, s.lng));
    if (around.length) m.flyToBounds(L.latLngBounds(around).pad(0.3), { maxZoom: 16, duration: .5 });
  }

  /** The selection's look and the buttons, without drawing the list again. */
  function marks() {
    for (const el of list.querySelectorAll<HTMLElement>(".pp-tile")) el.classList.toggle("sel", selected.has(el.dataset.key!));
    const sel = chosen(), guesses = sel.filter((p) => p.guessed);
    q<HTMLButtonElement>("[data-pp-accept]").disabled = !guesses.length;
    q<HTMLButtonElement>("[data-pp-skip]").disabled = !sel.some((p) => !p.skipped && !locked(p));
    q<HTMLButtonElement>("[data-pp-reset]").disabled = !sel.some((p) => p.placed || p.skipped);
    q<HTMLButtonElement>("[data-pp-undo]").disabled = !history.length;
    const left = photos.filter((p) => !p.camera && !p.placed && !p.skipped).length;
    info(isReadOnly() ? "This trip is view only. Make your own copy to place photos."
      : sel.length ? `${sel.length} selected. ${sel.every(locked) ? "Locked: they have a location of their own." : sel.some(unplaced) ? "Drag onto the map, or click the spot." : "Drag to move, or press Reset to take the move back."}${guesses.length ? ` Suggested: near ${guesses[0].near}.` : ""}`
        : `${left} still without a location. Drag photos onto the map; pictures on the map can be dragged too.`);
  }
  const info = (text: string) => { q("[data-pp-info]").textContent = text; };

  // ---- The list ----
  const tile = (p: Placed) => {
    order.push(p.key);
    return `<div class="pp-tile" draggable="${!isReadOnly() && !locked(p)}" data-key="${esc(p.key)}" title="${esc([p.name, when(p.t), sourceOf(p)].filter(Boolean).join(" · "))}">${thumbTag(p, 160, 'loading="lazy" decoding="async"')}${p.placed ? "<i>placed</i>" : p.skipped ? "<i>can't place</i>" : p.camera && which.value === "all" ? "<i>GPS</i>" : ""}<button type="button" class="pp-zoom" data-pp-zoom title="View full screen (or double-click the photo)">${icon("maximize")}</button></div>`;
  };
  /** The folders a group's photos are from, and who uploaded them. */
  const from = (g: Placed[]) => `<small>${[...new Set(g.map(sourceOf))].map(esc).join("<br>")}</small>`;
  function drawList() {
    const top = list.scrollTop;
    order = [];
    const spot = atSpot.map((k) => byKey.get(k)).filter((p): p is Placed => !!p);
    const here = spot.length ? `<section class="pp-group pp-spot"><header draggable="true"><b>At this spot</b><span>${spot.length} photo${spot.length === 1 ? "" : "s"}</span><button type="button" class="link-btn" data-pp-close>Close</button>${from(spot)}</header><div class="pp-grid">${spot.map(tile).join("")}</div></section>` : "";
    const shown = photos.filter(listed), inSpot = new Set(spot.map((p) => p.key));
    const groups = burstsOf(shown.filter((p) => !inSpot.has(p.key))).map((g) => {
      const a = g[0].t, b = g[g.length - 1].t, clock = (t: string) => t.slice(11, 16);
      const head = a ? `${fmtDate(a.slice(0, 10)) || a.slice(0, 10)} · ${clock(a)}${clock(b) !== clock(a) ? `–${clock(b)}` : ""}` : "No time";
      const near = g.find((p) => p.guessed)?.near;
      return `<section class="pp-group"><header draggable="true" title="Click to select all of them; drag to place them together"><b>${esc(head)}</b><span title="${esc(near || "")}">${near ? esc(near) : ""}</span><em>${g.length}</em>${from(g)}</header><div class="pp-grid">${g.map(tile).join("")}</div></section>`;
    }).join("");
    list.innerHTML = here + (groups || (here ? "" : `<p class="ph-empty">${!folders().length ? "No photo folders yet. Add one in the gallery." : !photos.length ? "No photos loaded." : which.value === "open" ? "Every photo here has a location." : "No photos match."}</p>`));
    list.scrollTop = top;
  }

  function drawFilters() {
    const dates = [...new Set(photos.map((p) => p.t.slice(0, 10) || "none"))].sort();
    const days = state.itinerary?.days || [];
    const opts = (all: string, items: [string, string][], now: string) => `<option value="">${all}</option>${items.map(([v, label]) => `<option value="${esc(v)}"${v === now ? " selected" : ""}>${esc(label)}</option>`).join("")}`;
    daySel.innerHTML = opts("All days", dates.map((d) => {
      const i = days.findIndex((x) => x.date === d);
      return [d, d === "none" ? "No time" : `${i >= 0 ? `Day ${i + 1} · ` : ""}${fmtDate(d) || d}`];
    }), daySel.value);
    srcSel.innerHTML = opts("All folders", [...new Map(photos.map((p) => [p.folder, p.folderName || p.folder.replace(/^local:/i, "").split(/[\\/]/).pop() || "Folder"]))], srcSel.value);
  }

  // ---- The map ----
  /** The stops of the day on show: the filter's, else the selected photos'. */
  function dayStops() {
    const date = daySel.value || chosen()[0]?.t.slice(0, 10) || "";
    const d = date ? planDays().find((x) => x.date === date) : undefined;
    return d ? [...d.stops, ...(d.home ? [d.home] : [])] : [];
  }
  /** The spot a drop near a stop or a picture snaps to. */
  function snap(ll: L.LatLng, skip?: L.Marker): L.LatLng {
    if (!m) return ll;
    const here = m.latLngToContainerPoint(ll);
    let best = ll, dist = SNAP;
    for (const group of [stops, pins]) group.eachLayer((l) => {
      if (l === skip || !(l instanceof L.Marker)) return;
      const d = m!.latLngToContainerPoint(l.getLatLng()).distanceTo(here);
      if (d < dist) { dist = d; best = l.getLatLng(); }
    });
    return best;
  }

  function drawMap() {
    if (!m || dragging) return;
    pins.clearLayers(); stops.clearLayers();
    if (layerOn("stops")) for (const s of dayStops()) {
      L.marker([s.lat, s.lng], { keyboard: false, zIndexOffset: -500, icon: L.divIcon({ className: "", html: `<div class="pp-stop"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) })
        .bindTooltip(esc(s.name), { direction: "top", offset: [0, -8] })
        .on("click", () => clicked(L.latLng(s.lat, s.lng)))
        .addTo(stops);
    }
    // Suggestions are shown for the selected photos only: they sit exactly on the pictures they're taken from, and
    // would cover them (and be dragged in their place).
    const visible = photos.filter((p) => p.lat != null && (p.guessed ? selected.has(p.key) && layerOn("guess") : selected.has(p.key) || (passes(p) && layerOn(p.placed ? "placed" : "camera"))));
    const b = m.getBounds().pad(0.3), z = m.getZoom();
    const cells = new Map<string, Placed[]>();
    for (const p of visible) {
      if (!b.contains([p.lat!, p.lng!])) continue;
      const pt = m.project([p.lat!, p.lng!], z);
      // A suggestion isn't grouped with real positions: dragging the group must not place it by accident.
      // (Locked ones apart too, so the others can still be dragged.)
      const key = `${Math.floor(pt.x / GRID)}_${Math.floor(pt.y / GRID)}_${p.guessed ? "g" : locked(p) ? "l" : "r"}`;
      cells.set(key, [...(cells.get(key) || []), p]);
    }
    for (const group of cells.values()) {
      const n = group.length, first = group.find((p) => selected.has(p.key)) || group[0];
      const lat = group.reduce((s, p) => s + p.lat!, 0) / n, lng = group.reduce((s, p) => s + p.lng!, 0) / n;
      const cls = [n > 1 ? "many" : "", first.guessed ? "guess" : "", group.every((p) => p.placed) ? "placed" : "", group.some((p) => selected.has(p.key)) ? "sel" : ""].join(" ");
      const mk = L.marker([lat, lng], { pane: "photos", zIndexOffset: group.some((p) => selected.has(p.key)) ? 1000 : 0, draggable: !isReadOnly() && !group.some(locked), autoPan: true, icon: L.divIcon({ className: "", html: `<div class="photo-pin ${cls}">${thumbTag(first, 128)}${n > 1 ? `<b>${n}</b>` : ""}</div>`, iconSize: [52, 52], iconAnchor: [26, 26] }) })
        .bindTooltip(`<div class="pp-tip">${thumbTag(first, 320)}${n > 1 ? `${n} photos<br><span class="pop-meta">${[...new Set(group.map(folderOf))].map(esc).join(", ")}</span>` : `${esc(first.name)}<br><span class="pop-meta">${esc(when(first.t))}<br>${esc(sourceOf(first))}</span>`}${first.guessed ? "<br>Suggested by the time: drag it to confirm" : ""}<br><span class="pop-meta">Click to open${group.some(locked) ? " · locked" : ""}</span></div>`, { direction: "top", offset: [0, -28] })
        .addTo(pins);
      // A click opens it full screen (going through the others here); they're selected and listed when it's closed.
      mk.on("click", () => {
        mk.closeTooltip();
        const items = [...group].sort((a, b) => a.t.localeCompare(b.t));
        keep(items.map((p) => p.key));
        showGallery(items.map(viewItem), items.indexOf(first));
      });
      mk.on("dragstart", () => { dragging = true; mk.closeTooltip(); });
      mk.on("dragend", () => {
        dragging = false;
        const to = snap(mk.getLatLng(), mk), dLat = to.lat - lat, dLng = to.lng - lng;
        // A group moves as it lies: each photo by the same distance (one spot stays one spot).
        change(Object.fromEntries(group.map((p) => [p.key, at(L.latLng(p.lat! + dLat, p.lng! + dLng))])));
        keep(group.map((p) => p.key));
      });
    }
  }

  function makeMap() {
    m = L.map(q(".pp-map"), { worldCopyJump: true }).setView([30, 10], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(m);
    // Their own pane, as on the main map: in Leaflet's marker pane its styles size pictures to their own shape.
    m.createPane("photos").style.zIndex = "620";
    stops = L.layerGroup().addTo(m); pins = L.layerGroup().addTo(m);
    m.on("moveend", drawMap);
    m.on("click", (e) => clicked(snap(e.latlng)));
    // Photos dragged from the list.
    const el = m.getContainer();
    el.addEventListener("dragover", (e) => { if (dragged.length) { e.preventDefault(); el.classList.add("over"); } });
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
    if (now !== trip) { trip = now; history = []; selected.clear(); atSpot = []; }
    // (With the time guess switched off in the gallery there are no suggestions.)
    q<HTMLInputElement>('[data-pp-layer="guess"]').disabled = !isPhotosGuess();
    photos = allPhotos();
    byKey = new Map(photos.map((p) => [p.key, p]));
    for (const k of selected) if (!byKey.has(k)) selected.delete(k);
    drawFilters();
    draw();
  }

  // ---- What the list and buttons do ----
  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-pp-close]")) { atSpot = []; selected.clear(); return draw(); }
    const el = target.closest<HTMLElement>(".pp-tile");
    if (el && target.closest("[data-pp-zoom]")) return view(el.dataset.key!);
    if (el) {
      const key = el.dataset.key!;
      if (e.shiftKey && anchor) {
        const a = order.indexOf(anchor), z = order.indexOf(key);
        if (a >= 0) { const from = anchor; select(order.slice(Math.min(a, z), Math.max(a, z) + 1)); anchor = from; return; }
      }
      if (e.ctrlKey || e.metaKey) { if (!selected.delete(key)) selected.add(key); anchor = key; marks(); drawMap(); return; }
      return select([key], true);
    }
    const head = target.closest("header");
    if (head) select([...head.parentElement!.querySelectorAll<HTMLElement>(".pp-tile")].map((x) => x.dataset.key!), true);
  });
  /** A photo full screen, going on through the others as listed. */
  const view = (key: string) => showGallery(order.map((k) => viewItem(byKey.get(k)!)), order.indexOf(key));
  list.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement, el = target.closest<HTMLElement>(".pp-tile");
    if (el && !target.closest("[data-pp-zoom]")) view(el.dataset.key!);
  });
  list.addEventListener("dragstart", (e) => {
    const target = e.target as HTMLElement, el = target.closest<HTMLElement>(".pp-tile");
    // A selected photo takes the whole selection along; a heading, its group.
    dragged = el ? (selected.has(el.dataset.key!) ? [...selected] : [el.dataset.key!])
      : [...(target.closest("header")?.parentElement?.querySelectorAll<HTMLElement>(".pp-tile") || [])].map((x) => x.dataset.key!);
    if (!dragged.length) return;
    dragging = true;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", `${dragged.length} photo${dragged.length === 1 ? "" : "s"}`);
    const img = el?.querySelector("img");
    if (img) e.dataTransfer!.setDragImage(img, 30, 30);
  });
  list.addEventListener("dragend", () => { dragged = []; dragging = false; q(".pp-map").classList.remove("over"); update(); });

  for (const sel of [which, daySel, srcSel]) sel.onchange = () => { selected.clear(); atSpot = []; list.scrollTop = 0; draw(); if (sel === daySel) fit(); };
  for (const c of box.querySelectorAll<HTMLInputElement>("[data-pp-layer]")) c.onchange = () => drawMap();
  lock.onchange = () => { localStorage.setItem(LOCK_KEY, lock.checked ? "1" : "0"); draw(); };
  q<HTMLButtonElement>("[data-pp-accept]").onclick = accept;
  q<HTMLButtonElement>("[data-pp-skip]").onclick = () => { const keys = chosen().map((p) => p.key); selected.clear(); atSpot = []; change(Object.fromEntries(keys.map((k) => [k, { skip: true as const }]))); draw(); };
  q<HTMLButtonElement>("[data-pp-reset]").onclick = () => { change(Object.fromEntries(chosen().filter((p) => p.placed || p.skipped).map((p) => [p.key, null]))); draw(); };
  q<HTMLButtonElement>("[data-pp-undo]").onclick = undo;
  box.closest("dialog")!.addEventListener("keydown", (e) => {
    if (!box.offsetParent || (e.target as HTMLElement).closest("select, input, button, textarea")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    else if (e.key === "Enter") { e.preventDefault(); accept(); }
  });

  /** The map goes to the photos of the filters that have a position (else the plan's stops). */
  function fit() {
    if (!m) return;
    const known = photos.filter((p) => passes(p) && p.lat != null && !p.guessed);
    const pts = (known.length ? known : photos.filter((p) => passes(p) && p.lat != null)).map((p) => L.latLng(p.lat!, p.lng!));
    const around = pts.length ? pts : planDays().flatMap((d) => d.stops.map((s) => L.latLng(s.lat, s.lng)));
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
