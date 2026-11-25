// The trip's photos in a window. On the left (a sidebar that can be hidden), everything to set up: where the photos come from (Google Drive folders and
// folders on this computer, as many as the trip has) and how they show on the map. On the right, every photo laid out by
// the day of the trip it was taken on (the others by date), with or without a spot on the map. Click one to go through
// them big (arrows, a strip along the bottom); the pin on a photo moves the map to where it was taken.
import { moveTo } from "../map/move";
import { closeOnBackdrop, esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { session, state } from "../core/state";
import { map } from "../map/map";
import {
  type Placed, addLocalFolder, addPhotosFolder, allPhotos, duration, folders, isPhotosGuess, isPhotosOn, loadMissing, onPhotosChange,
  photosState, removePhotosFolder, setPhotosFolderShown, setPhotosGuess, setPhotosOn, thumbTag, viewItem,
} from "../map/photos";
import { showGallery } from "../core/lightbox";
import { classifyLink, pickFolder } from "../core/folder-picker";
import { askText, tell } from "../core/ask";
import { loadSyncStatus } from "../saves/sync-client";
import { highlights } from "./preview-data";
import { type PlaceTool, placeTool } from "./photo-place";

/** A collage of their photos on top: one from as many days as there are, with the trip's name and when. */
function hero(all: Placed[], index: Map<Placed, number>) {
  const pics = highlights(all.filter((p) => !p.video).map((p) => ({ p, town: p.t.slice(0, 10), src: `${p.folder}|${p.id}` })), 5);
  if (!pics.length) return "";
  const dated = all.filter((p) => p.t).map((p) => p.t.slice(0, 10)).sort();
  const when = dated.length ? (dated[0] === dated.at(-1) ? fmtDate(dated[0]) : `${fmtDate(dated[0])} – ${fmtDate(dated.at(-1)!)}`) : "";
  const towns = [...new Set((state.itinerary?.days || []).filter((d) => dated.includes(d.date)).map((d) => String(d.city).split(/\/|→|->|,/)[0].trim()).filter(Boolean))];
  return `<div class="pv-hero ph-hero n${pics.length}">${pics.map(({ p }, i) => `<button type="button" class="pv-hi" data-i="${index.get(p)}">${thumbTag(p, i ? 500 : 1024, 'decoding="async"')}</button>`).join("")}
    <div class="pv-title"><h3>${esc(state.saveName || state.itinerary?.destination || "Your trip")}</h3>${towns.length ? `<p>${esc(towns.join(" → "))}</p>` : ""}<p>${esc([when, `${all.length} photo${all.length === 1 ? "" : "s"}${all.some((p) => p.video) ? " and videos" : ""}`].filter(Boolean).join(" · "))}</p></div></div>`;
}

let dlg: HTMLDialogElement | null = null;

/** How the window is shown, kept for next time: filling the whole window, and the sidebar hidden. */
const VIEW_KEY = "trip-planner-photos-view";
const view: { full: boolean; noSide: boolean } = { full: false, noSide: false };
try { Object.assign(view, JSON.parse(localStorage.getItem(VIEW_KEY) || "{}")); } catch { /* the usual view */ }

/** Placing photos on the map (instead of the gallery); the window fills the screen meanwhile. */
let placing = false, tool: PlaceTool | null = null;

function setPlacing(yes: boolean) {
  placing = yes;
  render();
  if (yes && dlg?.open) tool!.show();
}

function applyView() {
  if (!dlg) return;
  dlg.classList.toggle("placing", placing);
  dlg.querySelectorAll<HTMLButtonElement>("[data-ph-mode]").forEach((b) => b.classList.toggle("on", (b.dataset.phMode === "place") === placing));
  // With no folders yet the sidebar stays: it's where one is added.
  const none = !folders().length, hidden = view.noSide && !none;
  dlg.classList.toggle("full", view.full || placing);
  dlg.classList.toggle("no-side", hidden);
  const side = dlg.querySelector<HTMLButtonElement>("[data-ph-toggle-side]")!, full = dlg.querySelector<HTMLButtonElement>("[data-ph-full]")!;
  side.innerHTML = icon(hidden ? "panelOpen" : "panelClose");
  side.title = hidden ? "Show the sidebar" : "Hide the sidebar";
  side.disabled = none;
  full.innerHTML = icon(view.full ? "minimize" : "maximize");
  full.title = view.full ? "Back to a window" : "Fill the whole window";
}

function setView(change: Partial<typeof view>) {
  Object.assign(view, change);
  localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  applyView();
}

/** The photos in groups: each day of the trip that has some, then the other dates. */
function groups(photos: Placed[]) {
  const days = state.itinerary?.days || [], byDate = new Map<string, Placed[]>();
  for (const p of photos) { const d = p.t.slice(0, 10); byDate.set(d, [...(byDate.get(d) || []), p]); }
  const out: { head: string; sub: string; photos: Placed[] }[] = [];
  const used = new Set<string>();
  days.forEach((d, i) => {
    const list = byDate.get(d.date);
    if (!list) return;
    used.add(d.date);
    out.push({ head: `Day ${i + 1} · ${fmtDate(d.date) || d.date}`, sub: d.city || "", photos: list });
  });
  // Dates that aren't a day of the trip (before it, after it, or a trip with no plan yet); photos with no time last.
  for (const [date, list] of [...byDate].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || a[0].localeCompare(b[0]))) {
    if (used.has(date)) continue;
    out.push({ head: date ? fmtDate(date) || date : "No date", sub: !date ? "The photo has no time in it" : days.length ? "Not a day of the trip" : "", photos: list });
  }
  return out;
}

type Row = ReturnType<typeof photosState>["rows"][number];
/** One source's status line: loading, why it failed, or what it holds. */
const rowNote = (r: Row) =>
  r.off ? "Hidden" : r.loading ? "Loading…" : r.error ? r.error
    : !r.total ? "No photos in it"
      : `${r.shown + r.guessed} on the map${r.guessed ? ` (${r.guessed} by time)` : ""}${r.noSpot ? `, ${r.noSpot} not placed` : ""}${r.truncated ? ` (the first ${r.shown + r.guessed + r.noSpot} of ${r.total})` : ""}`
        + `${r.pending ? ` · reading ${r.pending} video${r.pending === 1 ? "" : "s"} for place and time…` : ""}${r.skipped ? ` · ${r.skipped} HEIC skipped` : ""}`;
const shortName = (l: string) => l.replace(/^local:/i, "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || l;

/** The left panel's changing parts: the sources and the switches. The two fields for adding stay as they are (what's typed in them is kept). */
function renderSide() {
  if (!dlg || !dlg.open) return;
  const s = photosState(), list = dlg.querySelector<HTMLElement>("[data-ph-sources]")!;
  list.innerHTML = s.rows.length ? s.rows.map((r, i) => `<li class="${r.off ? "off" : ""}${r.error ? " bad" : ""}">
      <input type="checkbox" data-src-show="${i}" ${r.off ? "" : "checked"} title="Show this source's photos">
      <span class="ph-src"><b title="${esc(r.link.replace(/^local:/i, ""))}">${esc(r.name || shortName(r.link))}</b>
        <span class="ph-kind">${r.local ? "This computer" : "Google Drive"}</span><span class="hint" data-src-note="${i}">${esc(rowNote(r))}</span></span>
      <button type="button" class="icon-btn" data-src-del="${i}" title="Take this folder off the trip">${icon("x")}</button></li>`).join("")
    : `<li class="empty">No folders yet. Add one below.</li>`;
  const rows = s.rows;
  list.querySelectorAll<HTMLInputElement>("[data-src-show]").forEach((c) => { c.onchange = () => setPhotosFolderShown(rows[+c.dataset.srcShow!].link, c.checked); });
  list.querySelectorAll<HTMLButtonElement>("[data-src-del]").forEach((b) => { b.onclick = () => removePhotosFolder(rows[+b.dataset.srcDel!].link); });
  const on = dlg.querySelector<HTMLInputElement>("[data-ph-on]")!, guess = dlg.querySelector<HTMLInputElement>("[data-ph-guess]")!;
  on.checked = isPhotosOn(); guess.checked = isPhotosGuess();
  dlg.querySelector<HTMLElement>("[data-ph-heic]")!.hidden = !rows.some((r) => r.skipped && !r.off);
}

function renderMain() {
  if (!dlg || !dlg.open) return;
  const s = photosState(), all = allPhotos();
  const errors = s.rows.filter((r) => r.error && !r.off).map((r) => `<p class="ph-note err">${icon("warn")} ${esc(r.name || shortName(r.link))}: ${esc(r.error)}</p>`).join("");
  const loading = s.rows.some((r) => r.loading && !r.off);
  const noSpot = all.filter((p) => p.lat == null).length, byTime = all.filter((p) => p.guessed).length, videos = all.filter((p) => p.video).length;
  dlg.querySelector<HTMLElement>("[data-ph-count]")!.textContent = all.length
    ? `${all.length - videos} photo${all.length - videos === 1 ? "" : "s"}${videos ? ` · ${videos} video${videos === 1 ? "" : "s"}` : ""}${byTime ? ` · ${byTime} placed by their time` : ""}${noSpot ? ` · ${noSpot} that can't be placed` : ""}${loading ? " · loading more…" : ""}` : "";
  let body: string;
  if (!folders().length) body = `<p class="ph-empty">No photo folders for this trip yet.<br><span class="hint">Add a Google Drive folder, or a folder from this computer, in the sidebar.</span></p>`;
  else if (!all.length) body = `${errors}<p class="ph-empty">${loading ? "Loading the photos…" : "No photos found in the shown folders."}</p>`;
  else {
    // The index in the whole list, so the viewer goes on from a photo into the next ones.
    const index = new Map(all.map((p, i) => [p, i]));
    body = errors + hero(all, index) + groups(all).map((g) => `<section class="ph-day"><h3>${esc(g.head)}${g.sub ? ` <span class="hint">${esc(g.sub)}</span>` : ""} <span class="ph-n">${g.photos.length}</span></h3>
      <div class="ph-grid">${g.photos.map((p) => `<div class="ph-tile" data-i="${index.get(p)}" title="${esc(p.name)}">
        ${thumbTag(p, 320, 'loading="lazy" decoding="async"')}
        ${p.video ? `<span class="ph-play"><i></i>${p.dur ? esc(duration(p.dur)) : ""}</span>` : ""}
        ${p.lat != null ? `<button type="button" class="ph-pin" data-pin="${index.get(p)}" title="${p.guessed ? `Show about where it was taken (placed by its time, near ${esc(p.near)})` : "Show where it was taken"}">${icon("pin")}</button>` : ""}</div>`).join("")}</div></section>`).join("");
  }
  const scroll = dlg.querySelector<HTMLElement>(".ph-body")!, top = scroll.scrollTop;
  scroll.innerHTML = body;
  scroll.scrollTop = top;
  scroll.querySelectorAll<HTMLElement>(".ph-hero [data-i]").forEach((b) => { b.onclick = () => showGallery(all.map(viewItem), +b.dataset.i!); });
  scroll.querySelectorAll<HTMLElement>(".ph-tile").forEach((t) => {
    t.onclick = (e) => {
      const pin = (e.target as HTMLElement).closest<HTMLElement>("[data-pin]");
      if (pin) {
        const p = all[+pin.dataset.pin!];
        dlg!.close();
        session.userMoved = true;
        if (map) moveTo(map, [p.lat!, p.lng!], 17);
        return;
      }
      showGallery(all.map(viewItem), +t.dataset.i!);
    };
  });
}

// (Only what's on screen is drawn: the gallery has thousands of pictures.)
const render = () => { if (!dlg?.open) return; applyView(); if (placing) tool?.update(); else { renderSide(); renderMain(); } };

/** The sidebar's own markup, made once. */
const SIDE = () => `<aside class="ph-side">
  <section>
    <h4>Photo folders</h4>
    <p class="hint">The photos and videos of this trip. Each can be a Google Drive folder or a folder on this computer.</p>
    <ul class="ph-sources" data-ph-sources></ul>
  </section>
  <section>
    <h4>Add a folder</h4>
    <div class="drive-add">
      <button type="button" class="drive-tile" data-ph-add><span class="dt-ic">${icon("plus")}</span><span class="dt-text"><b>Add a folder</b><span>From this computer or your Google Drive</span></span></button>
      <button type="button" class="link-btn drive-paste-btn" data-ph-paste>${icon("link")} Or paste a link or path</button>
    </div>
    <p class="hint" data-ph-how>Photos and videos in it and its folders. From this computer they're read from the disk; nothing is uploaded.</p>
    <p class="hint ph-err" data-ph-err hidden></p>
    <p class="hint" data-ph-heic hidden>iPhone HEIC pictures can't be shown by browsers, so they're skipped. Export them as JPEG to include them.</p>
  </section>
  <section>
    <h4>On the map</h4>
    <label class="ph-check"><input type="checkbox" data-ph-on> Show the photos on the map</label>
    <label class="ph-check" title="A photo with no GPS goes where your photos with GPS from a few minutes before or after were taken; without those, to the stop your plan has you at then. It's drawn with a dashed border"><input type="checkbox" data-ph-guess> Place photos without a location by their time</label>
  </section>
  <section><button type="button" class="btn" data-ph-refresh title="Ask Google again and read the folders again (a Drive list is kept for an hour)">Refresh all</button></section>
</aside>`;

/** Wires what's in the sidebar for good (the fields and buttons that stay). */
function wireSide(d: HTMLDialogElement) {
  const q = <T extends HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const say = (sel: string, text: string) => { const el = q(sel); el.textContent = text; el.hidden = !text; };
  /** Adds what was chosen or pasted: a folder on this computer, or a Google Drive folder (its link). */
  const add = (link: string) => {
    const local = link.replace(/^local:/i, "");
    say("[data-ph-err]", /^local:/i.test(link) || /^([a-z]:[\\/]|\\\\|\/|~)/i.test(local) ? addLocalFolder(local) : addPhotosFolder(link));
  };
  q<HTMLButtonElement>("[data-ph-add]").onclick = async () => {
    const f = await pickFolder({ providers: ["local", "drive"], title: "Choose a folder with photos", note: "Its photos and videos show on the map, with those in its folders (two levels down)." });
    if (f) add(f.link);
  };
  q<HTMLButtonElement>("[data-ph-paste]").onclick = async () => {
    const text = await askText({ title: "Paste a link or path", text: "A Google Drive folder's link (Share → Copy link), or a folder's path on this computer or a network drive.", placeholder: "https://drive.google.com/drive/folders/…  or  D:\\Photos\\Japan", ok: "Add", required: true });
    if (!text) return;
    const c = classifyLink(text);
    if (c.kind === "dropbox") return void tell({ title: "Dropbox photo folders aren't supported yet", text: "If the Dropbox app keeps the folder on this computer, add it from there: Add a folder → This computer." });
    if (c.kind === "cloud") return void tell({ title: `${c.name} links can't be opened here yet`, text: `If the ${c.name} app keeps the folder on this computer, add it from there: Add a folder → This computer.` });
    if (c.kind === "unknown") return say("[data-ph-err]", "That isn't a Google Drive link or a folder's path.");
    add(c.kind === "local" ? `local:${c.path}` : text);
  };
  // Signed in with Google (Settings → Sync): Drive folders work without sharing them publicly.
  loadSyncStatus().then((s) => { if (s?.signedIn) q("[data-ph-how]").textContent = "Photos and videos in it and its folders. You're signed in with Google, so your own Drive folders work without sharing them. From this computer they're read from the disk; nothing is uploaded."; });
  q<HTMLInputElement>("[data-ph-on]").onchange = (e) => setPhotosOn((e.target as HTMLInputElement).checked);
  q<HTMLInputElement>("[data-ph-guess]").onchange = (e) => setPhotosGuess((e.target as HTMLInputElement).checked);
  q<HTMLButtonElement>("[data-ph-refresh]").onclick = () => loadMissing(true);
}

/** Opens the window with the trip's photos and their settings. */
export function openPhotosView() {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "keys-dialog photos-dialog";
    dlg.innerHTML = `<div class="pl-head"><button type="button" class="icon-btn" data-ph-toggle-side></button><h2>${icon("images")} Photos</h2><span class="hint" data-ph-count></span>
        <div class="segs ph-modes"><button type="button" class="seg" data-ph-mode="gallery">Gallery</button><button type="button" class="seg" data-ph-mode="place" title="Drag photos onto the map to say where they were taken">Place on map</button></div>
        <button type="button" class="icon-btn ph-full-btn" data-ph-full></button>
        <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div>
      <div class="ph-wrap">${SIDE()}<div class="ph-body"></div></div><div class="pp-wrap"></div>`;
    document.body.append(dlg);
    // A click on the dimmed area around it closes it, like the other windows.
    closeOnBackdrop(dlg);
    wireSide(dlg);
    tool = placeTool(dlg.querySelector<HTMLElement>(".pp-wrap")!);
    dlg.querySelectorAll<HTMLButtonElement>("[data-ph-mode]").forEach((b) => { b.onclick = () => setPlacing(b.dataset.phMode === "place"); });
    dlg.querySelector<HTMLButtonElement>("[data-ph-toggle-side]")!.onclick = () => setView({ noSide: !dlg!.classList.contains("no-side") });
    dlg.querySelector<HTMLButtonElement>("[data-ph-full]")!.onclick = () => setView({ full: !view.full });
    // Sources finishing their load, or being added or taken off, show here as they happen.
    onPhotosChange(render);
  }
  if (!dlg.open) dlg.showModal();
  // Sources not loaded yet (the layer on the map may be off).
  loadMissing();
  render();
  if (placing) tool!.show();
}
