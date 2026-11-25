// The map's layer button, like Google Maps': a small tile in the bottom-left corner that opens a panel of picture tiles,
// the map style (place names in the local script or in English) and the transport lines (bus, tram, metro, train, boat,
// cable car), each switched on by itself.
import * as L from "leaflet";
import { api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { LINE_KINDS, type LineKind, isLineOn, linesEnabled, linesState, onLinesChange, setLineOn } from "./transit-lines";
import { cancelDownload, downloadState, downloadText, downloadView, onDownloadChange, viewCellCount } from "./lines-download";
import { gridState, onGridChange, setGridOn } from "./lines-grid";
import { setStayLines, stayLinesOn } from "./draw-stays";
import { isPhotosOn, onPhotosChange, photosState, setPhotosOn } from "./photos";
import { drawMap } from "./draw";
import { openPhotosView } from "../itinerary/photos-view";

export type Labels = "local" | "english";

// ---- Thumbnails: a little transit-map scene (72 × 52) for each choice, with a badge for the mode. ----------------------
const W = 72, H = 52;
/** A town from above: blocks between streets, a park; `water` puts a lake along the bottom, `hills` mountains instead. */
const ground = (opts: { water?: boolean; hills?: boolean } = {}) => `<rect width="${W}" height="${H}" fill="#f1eee8"/>
  <path d="M0 18 H72 M0 38 H72 M24 0 V52 M50 0 V52" stroke="#fff" stroke-width="3.2"/>
  <path d="M0 28 H72 M12 0 V52 M37 0 V52 M62 0 V52" stroke="#fff" stroke-width="1.3"/>
  <rect x="52.5" y="20.5" width="8" height="15" rx="1.5" fill="#cfe5c4"/>
  ${opts.water ? `<path d="M0 30 C 16 26, 30 34, 46 30 S 66 26, 72 29 V52 H0 Z" fill="#a9d3e6"/>` : ""}
  ${opts.hills ? `<path d="M0 52 L0 40 L18 26 L30 34 L46 10 L60 22 L72 16 V52 Z" fill="#dfe6d2"/><path d="M40 18 L46 10 L52 18 L48 16 L46 19 L43 16 Z" fill="#fff"/>
     <path d="M6 44 L18 34 L28 40 M34 32 L46 20 L58 30" stroke="#c9d3b8" stroke-width="1" fill="none"/>` : ""}`;
/** A station: white with a ring in the line's colour (an interchange gets a dark ring). */
const station = (x: number, y: number, c: string, r = 2.6) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="${c}" stroke-width="1.6"/>`;
const line = (d: string, c: string, w = 3) => `<path d="${d}" stroke="${c}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
const label = (x: number, y: number, text: string, size: number, weight = 600) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="#333" stroke="#f1eee8" stroke-width="2.5" paint-order="stroke">${text}</text>`;
const THUMBS: Record<LineKind | Labels, () => string> = {
  local: () => `${ground()}${label(4, 15, "東京", 12, 700)}${label(27, 34, "新宿", 8)}${label(4, 48, "渋谷", 8)}`,
  english: () => `${ground()}${label(4, 15, "Tokyo", 11, 700)}${label(27, 34, "Shinjuku", 7.5)}${label(4, 48, "Shibuya", 7.5)}`,
  // A bus route around the blocks, stopping along the way.
  bus: () => `${ground()}${line("M0 38 H24 V18 H50 V38 H72", "#2b7bd6")}${station(10, 38, "#2b7bd6")}${station(24, 28, "#2b7bd6")}${station(37, 18, "#2b7bd6")}${station(50, 28, "#2b7bd6")}${station(64, 38, "#2b7bd6")}`,
  // Two tram lines on the streets, meeting at a stop.
  tram: () => `${ground()}${line("M0 18 H72", "#c2185b")}${line("M24 0 V52", "#ef6c00")}${station(24, 18, "#333", 3.2)}${station(52, 18, "#c2185b")}${station(24, 42, "#ef6c00")}`,
  // Metro lines cutting across the town, an interchange where they cross.
  metro: () => `${ground()}${line("M0 10 H28 L46 30 H72", "#7b1fa2", 4.5)}${line("M36 0 V52", "#2e7d32", 4.5)}${station(14, 10, "#7b1fa2")}${station(36, 18, "#333", 3.6)}${station(60, 30, "#7b1fa2")}${station(36, 44, "#2e7d32")}`,
  // A railway (black and white, like on a map) with a station.
  train: () => `${ground()}${line("M0 44 C 22 42, 40 22, 72 10", "#3d434b", 5)}${line("M0 44 C 22 42, 40 22, 72 10", "#fff", 1.8).replace("/>", ' stroke-dasharray="4 4"/>')}<rect x="30" y="26" width="10" height="6" rx="1.5" fill="#fff" stroke="#3d434b" stroke-width="1.5" transform="rotate(-28 35 29)"/>`,
  // A ferry across the lake between two piers.
  boat: () => `${ground({ water: true })}<rect x="6" y="31" width="5" height="4" fill="#5d4037"/><rect x="60" y="30" width="5" height="4" fill="#5d4037"/>
    ${line("M10 35 C 24 50, 46 50, 62 34", "#0277bd", 2.2).replace("/>", ' stroke-dasharray="5 3.5"/>')}<path d="M30 44 h10 l-2 3.4 h-6 z M33 41 h4 v3 h-4 z" fill="#01579b"/>`,
  // A cable car up the mountain, a cabin on the cable.
  lift: () => `${ground({ hills: true })}<path d="M8 46 L46 12" stroke="#4e342e" stroke-width="1.2"/><rect x="5" y="44" width="6" height="5" fill="#4e342e"/><rect x="43" y="9" width="6" height="5" fill="#4e342e"/>
    <path d="M27 29 v3" stroke="#4e342e" stroke-width="1"/><rect x="23" y="32" width="8" height="7" rx="1.5" fill="#e65100"/><rect x="24.5" y="33.5" width="5" height="2.4" fill="#ffe0b2"/>`,
};
/** The trip's own lines: two stays joined by the drive, and a dashed line out to a day trip. */
const STAY_THUMB = () => `${ground()}${line("M10 40 C 24 34, 40 26, 56 14", "#c8102e", 3)}${line("M56 14 L 66 34", "#c8102e", 1.6).replace("/>", ' stroke-dasharray="3 3"/>')}
  <circle cx="66" cy="35" r="2.6" fill="#fff" stroke="#c8102e" stroke-width="1.6"/>
  <path d="M10 41 c -4 -5 -5 -7 -5 -9 a 5 5 0 0 1 10 0 c 0 2 -1 4 -5 9 z" fill="#c8102e"/><text x="8.2" y="34.6" font-size="6" font-weight="700" fill="#fff">1</text>
  <path d="M56 15 c -4 -5 -5 -7 -5 -9 a 5 5 0 0 1 10 0 c 0 2 -1 4 -5 9 z" fill="#c8102e"/><text x="54" y="8.6" font-size="6" font-weight="700" fill="#fff">2</text>`;
/** The day's route: numbered stops joined by the way between them (walked, then driven). */
const ROUTES_THUMB = () => `${ground()}${line("M8 42 L 22 30", "#1e88e5", 2.6).replace("/>", ' stroke-dasharray="1 4"/>')}${line("M22 30 C 34 22, 44 34, 62 12", "#1e88e5", 3)}
  ${[[8, 42, 1], [22, 30, 2], [62, 12, 3]].map(([x, y, n]) => `<circle cx="${x}" cy="${y}" r="5" fill="#1e88e5" stroke="#fff" stroke-width="1.2"/><text x="${x - 1.8}" y="${y + 2.2}" font-size="6.5" font-weight="700" fill="#fff">${n}</text>`).join("")}`;
/** Saved places: dots from the place lists, a starred must-see among them. */
const PLACES_THUMB = () => `${ground()}${[[12, 12], [30, 44], [46, 24], [60, 40], [18, 32], [56, 10]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.2" fill="#8e24aa" stroke="#fff" stroke-width="1.2"/>`).join("")}
  <path d="M36 9 l2.2 4.6 5 .6 -3.7 3.4 1 5 -4.5 -2.5 -4.5 2.5 1 -5 -3.7 -3.4 5 -.6 z" fill="#f9a825" stroke="#fff" stroke-width=".8"/>`;
/** A checkbox above the map is on. */
const box2 = (sel: string) => !!document.querySelector<HTMLInputElement>(sel)?.checked;
/** Photos: two snapshots pinned on the map, one with a count. */
const PHOTOS_THUMB = () => `${ground()}
  <g transform="rotate(-6 24 24)"><rect x="9" y="10" width="26" height="22" rx="2.5" fill="#fff" stroke="#d6d2ca"/><rect x="11.5" y="12.5" width="21" height="14" fill="#9ec9e8"/><path d="M11.5 26.5 l7 -8 l5 5 l3 -3 l6 6 z" fill="#5b8c5a"/><circle cx="27" cy="16.5" r="2" fill="#ffd54f"/></g>
  <g transform="rotate(5 52 34)"><rect x="40" y="22" width="26" height="22" rx="2.5" fill="#fff" stroke="#d6d2ca"/><rect x="42.5" y="24.5" width="21" height="14" fill="#f4b183"/><path d="M42.5 38.5 l6 -7 l5 4 l4 -3 l6 6 z" fill="#6d8f5e"/></g>
  <circle cx="63" cy="22" r="6" fill="#c8102e" stroke="#fff" stroke-width="1.3"/><text x="60.6" y="24.6" font-size="7.5" font-weight="700" fill="#fff">3</text>`;
const svg = (inner: string) => `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${inner}</svg>`;

/** The button's picture: the map itself where it's looking (a few tiles, a little further out), like Google's square. */
function liveMap(map: L.Map, size: number) {
  const z = Math.max(2, Math.min(17, Math.round(map.getZoom()) - 2)), n = 2 ** z, c = map.getCenter();
  const lat = (Math.max(-85, Math.min(85, c.lat)) * Math.PI) / 180;
  const x = ((c.lng + 180) / 360) * n, y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n;
  const S = 112, ix = Math.floor(x), iy = Math.floor(y), half = size / 2;
  const imgs: string[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const ty = iy + dy;
    if (ty < 0 || ty >= n) continue;
    const tx = (((ix + dx) % n) + n) % n;
    imgs.push(`<img src="https://tile.openstreetmap.org/${z}/${tx}/${ty}.png" alt="" draggable="false" style="left:${(half - (x - ix) * S + dx * S).toFixed(1)}px;top:${(half - (y - iy) * S + dy * S).toFixed(1)}px;width:${S}px;height:${S}px">`);
  }
  return `<span class="lp-live">${imgs.join("")}</span>`;
}

// ---- The button and the panel. ---------------------------------------------------------------------------------------
export function initLayerPicker(map: L.Map, labels: { get: () => Labels; set: (l: Labels) => void }) {
  const Ctl = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create("div", "layer-picker");
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      // Clicks stop here, not just by Leaflet's marker: a click redraws the button or panel, so by the time the map
      // looks, the element clicked is gone and it can't tell the click came from here (it opened "add a place").
      for (const ev of ["click", "dblclick", "mousedown", "pointerdown", "touchstart", "contextmenu"]) box.addEventListener(ev, (e) => e.stopPropagation());
      return box;
    },
  });
  const ctl = new Ctl({ position: "bottomleft" }).addTo(map);
  const box = ctl.getContainer()!;

  const tile = (key: string, thumb: string, name: string, on: boolean, ic = "") =>
    `<button type="button" class="lp-tile${on ? " on" : ""}" data-pick="${key}" aria-pressed="${on}"><span class="lp-thumb">${svg(thumb)}${ic}</span><span class="lp-label">${name}</span></button>`;

  let open = false;

  // The changing bits (notes, progress, the button's map and loading dot) are worked out here, and put in place by
  // patch() without redrawing the panel: it keeps its scroll position, hover and focus while the download runs.
  const texts = () => {
    const st = linesState(), g = gridState();
    return {
      note: st.pending ? `Loading lines for ${st.pending} area${st.pending > 1 ? "s" : ""}, from the middle of the map out… A big city's first look takes a while.`
        : st.far ? "Zoom in to a city to see the lines." : "From OpenStreetMap. Lines show from city level; hover one for its name.",
      dl: downloadState() ? downloadText() : "",
      grid: !g.on ? "" : g.far ? "Zoom in to see the areas." : g.done != null ? `In view: ${g.done} downloaded${g.waiting ? `, ${g.waiting} on the way` : ""}.` : "",
      loading: st.pending > 0,
      canDownload: viewCellCount(map) <= 160,
      photos: photosNote(),
    };
  };
  /** The Photos tile's line: what's on the map, or where to set it up. */
  const photosNote = () => {
    const ps = photosState();
    if (!ps.on) return "";
    if (!ps.rows.length) return "No photo folders yet: add some in the Photos window.";
    return `${ps.shown + ps.guessed} photo${ps.shown + ps.guessed === 1 ? "" : "s"} on the map${ps.guessed ? ` (${ps.guessed} placed by their time)` : ""}${ps.loading ? " · loading…" : ""}.`;
  };
  const buttonInner = () => {
    const shown = LINE_KINDS.filter((k) => isLineOn(k.k));
    return `${liveMap(map, 72)}${shown.length ? `<span class="lp-on">${shown.map((k) => `<i style="--c:${k.colour}"></i>`).join("")}</span>` : ""}<span class="lp-name">${icon("layers")} Layers</span>`;
  };

  const render = () => {
    const t = texts(), lab = labels.get(), g = gridState();
    const panel = box.querySelector<HTMLElement>(".lp-panel"), scroll = panel?.scrollTop || 0;
    box.innerHTML = `<button type="button" class="lp-btn${t.loading ? " loading" : ""}" aria-expanded="${open}" title="Map style and transport lines">${buttonInner()}</button>
      ${open ? `<div class="lp-panel" role="dialog" aria-label="Map layers">
        <h4>Map</h4>
        <div class="lp-grid">${tile("local", THUMBS.local(), "Local names", lab === "local")}${tile("english", THUMBS.english(), "English names", lab === "english")}</div>
        <h4>Your trip</h4>
        <div class="lp-grid">${tile("stays", STAY_THUMB(), "Stay lines", stayLinesOn())}${tile("routes", ROUTES_THUMB(), "Day routes", box2("#showRoutes"))}${tile("places", PLACES_THUMB(), "Saved places", box2("#showPlaces"))}</div>
        <h4>Photos</h4>
        <div class="lp-grid">${tile("photos", PHOTOS_THUMB(), "Photos", isPhotosOn())}</div>
        <p class="hint lp-photos-line"><span data-t="photos"${t.photos ? "" : " hidden"}>${esc(t.photos)}</span> <button type="button" class="link-btn" data-photos-open title="Choose the folders, how photos are placed, and see them all by day">Photos window…</button></p>
        <h4>Transport lines</h4>
        ${!linesEnabled() ? `<p class="hint">Off. Every bus, tram and train line from OpenStreetMap can be shown here (switch it on in Settings → Map); downloading them from the public servers is slow. The lines and stops of the rides in your plan show without it.</p>` : `<div class="lp-grid">${LINE_KINDS.map((k) => tile(k.k, THUMBS[k.k](), k.name, isLineOn(k.k), `<i class="lp-badge" style="--c:${k.colour}">${icon(k.ic)}</i>`)).join("")}</div>
        <p class="hint" data-t="note">${esc(t.note)}</p>
        <div class="lp-download">
          <button type="button" class="btn" data-dl-view title="Fetch the lines in view now and keep them (they're kept for 90 days)"${t.canDownload ? "" : " hidden"}>${icon("download")} Download this area</button>
          <span class="hint" data-t="far"${t.canDownload ? " hidden" : ""}>Zoom in to a city to download its lines.</span>
          <div class="lp-progress" data-t="progress" hidden></div>
          <span class="hint" data-t="dl"${t.dl ? "" : " hidden"}>${esc(t.dl)}</span>
          <label class="lp-check"><input type="checkbox" data-grid${g.on ? " checked" : ""}> Show download areas on the map</label>
          ${g.on ? `<div class="lp-legend"><span><i class="done"></i>Downloaded</span><span><i class="now"></i>Downloading</span><span><i class="wait"></i>Waiting</span><span><i class="none"></i>Not asked for</span></div>` : ""}
          <span class="hint" data-t="grid"${t.grid ? "" : " hidden"}>${esc(t.grid)}</span>
        </div>`}
      </div>` : ""}`;
    // As tall as the map has room for above the button (a narrow or short map column: it mustn't run under the bar).
    const lp = box.querySelector<HTMLElement>(".lp-panel");
    if (lp) { const room = (box.closest(".leaflet-container")?.clientHeight || 600) - 86 - 14; lp.style.maxHeight = `${Math.max(160, Math.min(460, room))}px`; }
    const p2 = box.querySelector<HTMLElement>(".lp-panel");
    if (p2) p2.scrollTop = scroll;
    box.querySelector<HTMLButtonElement>("[data-dl-view]")?.addEventListener("click", () => {
      const n = downloadView(map);
      toast(n ? `Downloading ${n} new area${n > 1 ? "s" : ""} in the background` : "This area is already downloaded or on its way");
    });
    box.querySelector<HTMLButtonElement>("[data-photos-open]")?.addEventListener("click", () => openPhotosView());
    const grid = box.querySelector<HTMLInputElement>("[data-grid]");
    if (grid) grid.onchange = () => { setGridOn(grid.checked); render(); };
    // With a mouse, hovering already opened it: a click keeps it open. On a touch screen a tap opens and closes it.
    box.querySelector<HTMLButtonElement>(".lp-btn")!.onclick = () => show(canHover ? true : !open);
    box.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.pick!;
        if (k === "local" || k === "english") labels.set(k);
        else if (k === "stays") { setStayLines(!stayLinesOn()); drawMap(); }
        else if (k === "photos") setPhotosOn(!isPhotosOn());
        // The same switches as the Places and Routes boxes above the map (kept in step: this flips the box).
        else if (k === "routes" || k === "places") {
          const cb = document.querySelector<HTMLInputElement>(k === "routes" ? "#showRoutes" : "#showPlaces");
          if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
        }
        else setLineOn(k as LineKind, !isLineOn(k as LineKind));
        render();
      };
    });
    if (open) pollProgress();
  };

  /** Puts the changing bits in place, leaving the rest of the panel as it is. */
  const patch = () => {
    const t = texts(), btn = box.querySelector<HTMLButtonElement>(".lp-btn");
    if (btn) {
      btn.classList.toggle("loading", t.loading);
      // Only when it changed (the map moved, a kind switched): the tiles stay put otherwise.
      const inner = buttonInner();
      if (btn.dataset.html !== inner) { btn.innerHTML = inner; btn.dataset.html = inner; }
    }
    const set = (k: string, text: string) => { const el = box.querySelector<HTMLElement>(`[data-t="${k}"]`); if (el) { el.hidden = !text; if (el.textContent !== text) el.textContent = text; } };
    set("note", t.note); set("dl", t.dl); set("grid", t.grid); set("photos", t.photos);

    const dlBtn = box.querySelector<HTMLElement>("[data-dl-view]"), far = box.querySelector<HTMLElement>('[data-t="far"]');
    if (dlBtn) dlBtn.hidden = !t.canDownload;
    if (far) far.hidden = t.canDownload;
  };

  // ---- The download's live progress: size so far, speed, time, and the pause before the next area. -----------------
  type Worker = { kind: "main" | "main2" | "swiss"; server: string; ids: string[]; cells: number; secs: number; askedSecs: number; bytes: number; speed: number; retryIn: number; why: string; nextIn: number; running: boolean;
    last: { cells: number; bytes: number; stored: number; ms: number; ok: boolean; server: string; cancelled?: boolean } | null };
  type Progress = { workers: Worker[]; paused: boolean; down?: { server: string; secs: number }[]; left: { view: number; background: number } };
  const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`);
  const mins = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} s`);
  /** Which download it is: the Swiss server's, or one of the two on the main server. */
  const who = (w: Worker) => (w.kind === "swiss" ? "Swiss server" : w.kind === "main" ? "Main server 1" : "Main server 2");
  const progressHtml = (p: Progress) => {
    const left = p.left.view + p.left.background;
    const lines: string[] = [];
    if (p.paused) lines.push(`<b>Paused</b> while a plan is being made; it carries on after.`);
    for (const d of p.down || []) lines.push(`${icon("warn")} <b>${esc(d.server)}</b> can't be reached or is turning requests away: the other servers are used, and it's tried again in ${mins(d.secs)}`);
    for (const w of p.workers) {
      if (w.cells) {
        // On another server than its own: the one it's on now says so.
        const at = w.server && !(w.kind === "swiss" ? /osm\.ch/ : /overpass-api\.de/).test(w.server) ? ` → trying ${esc(w.server)}` : "";
        const how = w.retryIn ? `${esc(w.why || "servers busy, trying again")}: ${w.retryIn} s`
          : w.bytes ? `${size(w.bytes)} so far${w.speed ? ` · ${size(w.speed)}/s` : ""}`
          : w.askedSecs ? `waiting for the answer (${mins(w.askedSecs)})` : "starting…";
        lines.push(`<b>${icon("download")} ${who(w)}</b>${at} · ${w.cells} area${w.cells > 1 ? "s" : ""} · ${mins(w.secs)} · ${how} <button type="button" class="link-btn" data-dl-cancel="${esc(w.ids.join(","))}" title="Stop this download; these areas aren't asked for again until you download them by hand">Cancel</button>`);
      } else if (w.running && w.nextIn && left) lines.push(`<b>${who(w)}</b> · next in ${w.nextIn} s`);
      else if (w.last && left) lines.push(`<b>${who(w)}</b> · ${w.last.cancelled ? "last one cancelled" : w.last.ok ? `last: ${w.last.cells} area${w.last.cells > 1 ? "s" : ""} in ${mins(Math.max(1, Math.round(w.last.ms / 1000)))}` : "last one failed (tried again in 10 min)"}`);
    }
    if (!left && !p.workers.some((w) => w.cells)) lines.push(`Nothing waiting to download.`);
    if (left) lines.push(`${left} area${left > 1 ? "s" : ""} waiting${p.left.view ? ` (${p.left.view} in view first)` : ""}`);
    return lines.map((l) => `<span>${l}</span>`).join("");
  };
  let progressTimer: number | undefined;
  const pollProgress = async () => {
    clearTimeout(progressTimer);
    if (!open) return;
    try {
      const p = await api<Progress>("/api/lines/progress");
      const el = box.querySelector<HTMLElement>('[data-t="progress"]');
      if (el) {
        // (The time in it changes every second: drawn again, with its Cancel buttons.)
        const html = progressHtml(p); el.hidden = !html;
        if (el.dataset.html !== html) {
          el.innerHTML = html; el.dataset.html = html;
          el.querySelectorAll<HTMLButtonElement>("[data-dl-cancel]").forEach((b) => { b.onclick = async () => { b.disabled = true; await cancelDownload(b.dataset.dlCancel!.split(",")); pollProgress(); }; });
        }
      }
    } catch { /* the server is away: next time */ }
    progressTimer = window.setTimeout(pollProgress, 1000);
  };

  const show = (o: boolean) => { if (o !== open) { open = o; render(); } };
  render();
  // Opens as soon as the pointer is over the button, closes a moment after it leaves (time to move up into the panel).
  // On a touch screen, which can't hover, a tap opens and closes it.
  const canHover = matchMedia("(hover: hover)").matches;
  let leave: number | undefined;
  box.addEventListener("mouseenter", () => { clearTimeout(leave); if (canHover) show(true); });
  box.addEventListener("mouseleave", () => { clearTimeout(leave); if (canHover) leave = window.setTimeout(() => show(false), 350); });
  // Closes on a click elsewhere or Esc; follows loading and zoom while open.
  // (By the click's path: a tile's own click redraws the panel, so the element clicked is gone by now.)
  document.addEventListener("click", (e) => { if (open && !e.composedPath().includes(box)) show(false); });
  document.addEventListener("keydown", (e) => { if (open && e.key === "Escape") show(false); });
  onLinesChange(patch);
  onDownloadChange(patch);
  onGridChange(patch);
  onPhotosChange(patch);
}
