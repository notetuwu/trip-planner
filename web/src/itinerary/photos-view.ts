// The trip's photos in a window. On the left (a sidebar that can be hidden), everything to set up: where the photos come from (Google Drive folders and
// folders on this computer, as many as the trip has) and how they show on the map. On the right, every photo laid out by
// the day of the trip it was taken on (the others by date), with or without a spot on the map, and a timeline of the days
// down its right edge to jump between them. Click one to go through them big (arrows, a strip along the bottom); the pin on a photo moves the map to where it was taken.
import { moveTo } from "../map/move";
import { closeOnBackdrop, esc } from "../core/dom";
import { addDays, dayColor, fmtDate, fmtShort } from "../core/format";
import { icon } from "../core/icons";
import { session, state } from "../core/state";
import { showPane } from "../core/layout";
import { map } from "../map/map";
import {
  type Placed, addLocalFolder, addPhotosFolder, allPhotos, deletePhoto, duration, folderOf, folders, isLocalFolder, isPhotosGuess, isPhotosOn, loadMissing, onPhotosChange,
  photosState, removePhotosFolder, setPhotosFolderShown, setPhotosGuess, setPhotosOn, thumbTag, viewItem,
} from "../map/photos";
import { showGallery } from "../core/lightbox";
import { classifyLink, pickFolder } from "../core/folder-picker";
import { askConfirm, askText, tell } from "../core/ask";
import { loadSyncStatus } from "../saves/sync-client";
import { highlights } from "./preview-data";
import { type PlaceTool, placeTool } from "./photo-place";
import { photoTimeline } from "./photos-timeline";
import { personDot } from "../saves/collab";
import { photoTip } from "./photo-tip";
import { stayIndexOn } from "./photo-stays";

/** A collage of their photos on top: one from as many days as there are, with the trip's name (the stay's, when only
 *  one's photos are shown) and when. */
function hero(all: Placed[], index: Map<Placed, number>) {
  const pics = highlights(all.filter((p) => !p.video).map((p) => ({ p, town: p.t.slice(0, 10), src: `${p.folder}|${p.id}` })), 5);
  if (!pics.length) return "";
  const dated = all.filter((p) => p.t).map((p) => p.t.slice(0, 10)).sort();
  const when = dated.length ? (dated[0] === dated.at(-1) ? fmtDate(dated[0]) : `${fmtDate(dated[0])} – ${fmtDate(dated.at(-1)!)}`) : "";
  const towns = [...new Set((state.itinerary?.days || []).filter((d) => dated.includes(d.date)).map((d) => String(d.city).split(/\/|→|->|,/)[0].trim()).filter(Boolean))];
  return `<div class="pv-hero ph-hero n${pics.length}">${pics.map(({ p }, i) => `<button type="button" class="pv-hi" data-i="${index.get(p)}">${thumbTag(p, i ? 500 : 1024, 'decoding="async"')}</button>`).join("")}
    <div class="pv-title"><h3>${esc(stayShown == null ? state.saveName || state.itinerary?.destination || "Your trip" : stayShown < 0 ? "Other dates" : stayName(stayShown))}</h3>${towns.length ? `<p>${esc(towns.join(" → "))}</p>` : ""}<p>${esc([when, `${all.length} photo${all.length === 1 ? "" : "s"}${all.some((p) => p.video) ? " and videos" : ""}`, uploaderShown == null ? "" : `by ${uploaderShown}`].filter(Boolean).join(" · "))}</p></div></div>`;
}

let dlg: HTMLDialogElement | null = null;

/** How the window is shown, kept for next time: filling the whole window, the sidebar hidden, its folders folded. */
const VIEW_KEY = "trip-planner-photos-view";
const view: { full: boolean; noSide: boolean; foldersShut: boolean } = { full: false, noSide: false, foldersShut: false };
try { Object.assign(view, JSON.parse(localStorage.getItem(VIEW_KEY) || "{}")); } catch { /* the usual view */ }

/** Placing photos on the map (instead of the gallery); the window fills the screen meanwhile. */
let placing = false, tool: PlaceTool | null = null;
/** A phone has room for one of the two: the photos, or (from its button) the folders and settings in their place. */
const phone = matchMedia("(max-width: 900px)");
let phoneSide = false;
let timeline: ReturnType<typeof photoTimeline>;
let tip: ReturnType<typeof photoTip>;

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
  const none = !folders().length, hidden = (phone.matches ? !phoneSide : view.noSide) && !none;
  dlg.classList.toggle("full", view.full || placing);
  dlg.classList.toggle("no-side", hidden);
  const side = dlg.querySelector<HTMLButtonElement>("[data-ph-toggle-side]")!, full = dlg.querySelector<HTMLButtonElement>("[data-ph-full]")!;
  side.innerHTML = icon(phone.matches ? (hidden ? "folder" : "arrowLeft") : hidden ? "panelOpen" : "panelClose");
  side.title = phone.matches ? (hidden ? "Photo folders and settings" : "Back to the photos") : hidden ? "Show the sidebar" : "Hide the sidebar";
  side.disabled = none;
  full.innerHTML = icon(view.full ? "minimize" : "maximize");
  full.title = view.full ? "Back to a window" : "Fill the whole window";
}

function setView(change: Partial<typeof view>) {
  Object.assign(view, change);
  localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  applyView();
}

/** The stay whose photos alone are shown (its place in the list; -1: those of no stay's dates), or all (null). */
let stayShown: number | null = null;
const stayOfPhoto = (p: Placed) => stayIndexOn(p.t.slice(0, 10), state.stays);
const stayName = (i: number) => state.stays[i]?.city.split(",")[0].trim() || `Stay ${i + 1}`;
/** The colour of a day's stay, or "" when it's no stay's. */
const stayColorOn = (date: string) => { const i = stayIndexOn(date, state.stays); return i < 0 ? "" : dayColor(i); };

/** Whose uploads alone are shown (their name), or everyone's (null). */
let uploaderShown: string | null = null;
const inStay = (p: Placed) => stayShown == null || stayOfPhoto(p) === stayShown;
const byUploader = (p: Placed) => uploaderShown == null || p.by === uploaderShown;

/** One choice of a filter in the sidebar: its mark, name and how many photos it would show. */
const choice = (data: string, on: boolean, mark: string, name: string, sub: string, n: number, color = "", all = false) =>
  `<li><button type="button" ${data} aria-pressed="${on}"${color ? ` style="--stay:${color}"` : ""}${n || all ? "" : " disabled"}>
    ${mark}<span class="ph-what"><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span><em>${n}</em></button></li>`;

/** A click on a filter's choice: that one alone (again: all), from the top. */
function filtered() {
  // On a phone the filters are in place of the photos: back to those.
  phoneSide = false;
  render();
  dlg!.querySelector<HTMLElement>(".ph-body")!.scrollTop = 0;
}

/** The sidebar's two filters: the stays, each in its colour, and who uploaded (where the cloud says: files in a folder
 *  on this computer have no uploader). Each counts what it would show with the other's choice; a section with nothing
 *  to choose from isn't there. */
function renderFilters(every: Placed[]) {
  const stayBox = dlg!.querySelector<HTMLElement>("[data-ph-stays-box]")!, peopleBox = dlg!.querySelector<HTMLElement>("[data-ph-people-box]")!;
  const people = new Map<string, string>();
  for (const p of every) if (p.by && !people.get(p.by)) people.set(p.by, p.byPic || "");
  stayBox.hidden = !state.stays.some((s) => s.start);
  peopleBox.hidden = !people.size;
  // A choice with nothing to show any more (its folder hidden, or another trip now): all again.
  if (stayBox.hidden || (stayShown != null && !every.some(inStay))) stayShown = null;
  if (uploaderShown != null && !every.some((p) => inStay(p) && byUploader(p))) uploaderShown = null;

  const theirs = every.filter(byUploader), counts = new Map<number, number>();
  for (const p of theirs) { const i = stayOfPhoto(p); counts.set(i, (counts.get(i) || 0) + 1); }
  const stays = stayBox.querySelector<HTMLElement>("[data-ph-stays]")!;
  stays.innerHTML = choice(`data-stay=""`, stayShown == null, "<i></i>", "All photos", "", theirs.length, "", true)
    + state.stays.map((s, i) => choice(`data-stay="${i}"`, stayShown === i, "<i></i>", stayName(i), s.start ? `${fmtShort(s.start)} – ${fmtShort(addDays(s.start, s.nights))}` : "No dates", counts.get(i) || 0, dayColor(i))).join("")
    + (every.some((p) => stayOfPhoto(p) < 0) ? choice(`data-stay="-1"`, stayShown === -1, "<i></i>", "Other dates", "Not during a stay", counts.get(-1) || 0, "var(--line-strong)") : "");
  stays.querySelectorAll<HTMLButtonElement>("[data-stay]").forEach((b) => {
    b.onclick = () => {
      const picked = b.dataset.stay ? +b.dataset.stay : null;
      stayShown = picked === stayShown ? null : picked;
      filtered();
    };
  });

  const there = every.filter(inStay), names = [...people.keys()].sort((a, b) => a.localeCompare(b));
  const list = peopleBox.querySelector<HTMLElement>("[data-ph-people]")!;
  list.innerHTML = choice(`data-by=""`, uploaderShown == null, `<span class="who-dot ph-everyone">${icon("users")}</span>`, "Everyone", "", there.length, "", true)
    + names.map((n, i) => choice(`data-by="${i}"`, uploaderShown === n, personDot(n, people.get(n)), n, "", there.filter((p) => p.by === n).length)).join("");
  list.querySelectorAll<HTMLButtonElement>("[data-by]").forEach((b) => {
    b.onclick = () => {
      const picked = b.dataset.by ? names[+b.dataset.by] : null;
      uploaderShown = picked === uploaderShown ? null : picked;
      filtered();
    };
  });
}

/** The photos in groups: each day of the trip that has some, then the other dates. */
function groups(photos: Placed[]) {
  const days = state.itinerary?.days || [], byDate = new Map<string, Placed[]>();
  for (const p of photos) { const d = p.t.slice(0, 10); byDate.set(d, [...(byDate.get(d) || []), p]); }
  const out: { head: string; short: string; sub: string; color: string; photos: Placed[] }[] = [];
  const used = new Set<string>();
  days.forEach((d, i) => {
    const list = byDate.get(d.date);
    if (!list) return;
    used.add(d.date);
    out.push({ head: `Day ${i + 1} · ${fmtDate(d.date) || d.date}`, short: `Day ${i + 1}`, sub: d.city || "", color: stayColorOn(d.date), photos: list });
  });
  // Dates that aren't a day of the trip (before it, after it, or a trip with no plan yet); photos with no time last.
  for (const [date, list] of [...byDate].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || a[0].localeCompare(b[0]))) {
    if (used.has(date)) continue;
    out.push({ head: date ? fmtDate(date) || date : "No date", short: date ? fmtShort(date) || date : "No date", sub: !date ? "The photo has no time in it" : days.length ? "Not a day of the trip" : "", color: stayColorOn(date), photos: list });
  }
  return out;
}

/** What the confirmation says deleting does. */
function deleteText(p: Placed) {
  const what = `“${p.name}” (in ${folderOf(p)})`;
  if (p.del === "remove") return `${what} belongs to ${p.by || "someone else"}, so it can't be deleted. It will be removed from the folder, for everyone who has it. The file isn't put in the trash; to have it here again, it has to be added to the folder again.`;
  if (p.del === "permanent") return `${what} will be deleted for good: its drive has no Recycle Bin. This can't be undone.`;
  if (!isLocalFolder(p.folder)) return `${what} will be moved to the trash in Google Drive, so it's gone for everyone who has the folder. It can be restored from there for 30 days.`;
  return `${what} will be moved from its folder to this computer's Recycle Bin or Trash. You can restore it from there.`;
}

async function confirmDelete(p: Placed) {
  const remove = p.del === "remove", what = p.video ? "video" : "photo";
  if (!(await askConfirm({ title: remove ? `Remove this ${what} from the folder?` : `Delete this ${what}?`, text: deleteText(p), ok: remove ? "Remove" : "Delete", danger: true }))) return;
  try { await deletePhoto(p); }
  catch (e) { await tell({ title: remove ? "Couldn't remove it" : "Couldn't delete it", text: (e as Error).message }); }
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
  // With no folders yet it's open: it's where one is added.
  dlg.querySelector<HTMLDetailsElement>("[data-ph-folders]")!.open = !rows.length || !view.foldersShut;
  dlg.querySelector<HTMLElement>("[data-ph-heic]")!.hidden = !rows.some((r) => r.skipped && !r.off);
}

function renderMain() {
  if (!dlg || !dlg.open) return;
  const s = photosState(), every = allPhotos();
  renderFilters(every);
  // What's listed (and gone through in the viewer): all, or what the filters leave.
  const all = every.filter((p) => inStay(p) && byUploader(p));
  const errors = s.rows.filter((r) => r.error && !r.off).map((r) => `<p class="ph-note err">${icon("warn")} ${esc(r.name || shortName(r.link))}: ${esc(r.error)}</p>`).join("");
  const loading = s.rows.some((r) => r.loading && !r.off);
  const noSpot = every.filter((p) => p.lat == null).length, byTime = every.filter((p) => p.guessed).length, videos = every.filter((p) => p.video).length;
  dlg.querySelector<HTMLElement>("[data-ph-count]")!.textContent = every.length
    ? `${every.length - videos} photo${every.length - videos === 1 ? "" : "s"}${videos ? ` · ${videos} video${videos === 1 ? "" : "s"}` : ""}${byTime ? ` · ${byTime} placed by their time` : ""}${noSpot ? ` · ${noSpot} that can't be placed` : ""}${loading ? " · loading more…" : ""}` : "";
  let body: string, shown: ReturnType<typeof groups> = [];
  if (!folders().length) body = `<p class="ph-empty">No photo folders for this trip yet.<br><span class="hint">Add a Google Drive folder, or a folder from this computer, in the sidebar.</span></p>`;
  else if (!all.length) body = `${errors}<p class="ph-empty">${loading ? "Loading the photos…" : "No photos found in the shown folders."}</p>`;
  else {
    // The index in the whole list, so the viewer goes on from a photo into the next ones.
    const index = new Map(all.map((p, i) => [p, i]));
    shown = groups(all);
    body = errors + hero(all, index) + shown.map((g) => `<section class="ph-day"><h3>${g.color ? `<i class="ph-dot" style="--stay:${g.color}"></i>` : ""}${esc(g.head)}${g.sub ? ` <span class="hint">${esc(g.sub)}</span>` : ""} <span class="ph-n">${g.photos.length}</span></h3>
      <div class="ph-grid">${g.photos.map((p) => `<div class="ph-tile" data-i="${index.get(p)}">
        ${thumbTag(p, 320, 'loading="lazy" decoding="async"')}
        ${p.del ? `<button type="button" class="ph-del" data-del="${index.get(p)}" title="${p.del === "remove" ? "Remove from the folder" : "Delete the file"}">${icon(p.del === "remove" ? "x" : "trash")}</button>` : ""}
        ${p.video ? `<span class="ph-play"><i></i>${p.dur ? esc(duration(p.dur)) : ""}</span>` : ""}
        ${p.lat != null ? `<button type="button" class="ph-pin" data-pin="${index.get(p)}" title="${p.guessed ? "Show about where it was taken" : "Show where it was taken"}">${icon("pin")}</button>` : ""}</div>`).join("")}</div></section>`).join("");
  }
  const scroll = dlg.querySelector<HTMLElement>(".ph-body")!, top = scroll.scrollTop;
  scroll.innerHTML = body;
  tip.set(all);
  const sections = scroll.querySelectorAll<HTMLElement>(".ph-day");
  timeline(shown.map((g, i) => ({
    label: g.short, title: g.head, color: g.color, el: sections[i],
    sub: [g.sub, `${g.photos.length} photo${g.photos.length === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
  })));
  scroll.scrollTop = top;
  scroll.querySelectorAll<HTMLElement>(".ph-hero [data-i]").forEach((b) => { b.onclick = () => showGallery(all.map(viewItem), +b.dataset.i!); });
  scroll.querySelectorAll<HTMLElement>(".ph-tile").forEach((t) => {
    t.onclick = (e) => {
      const del = (e.target as HTMLElement).closest<HTMLElement>("[data-del]");
      if (del) return void confirmDelete(all[+del.dataset.del!]);
      const pin = (e.target as HTMLElement).closest<HTMLElement>("[data-pin]");
      if (pin) {
        const p = all[+pin.dataset.pin!];
        dlg!.close();
        showPane("map");
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
  <div class="ph-side-scroll">
  <section data-ph-stays-box hidden>
    <h4>${icon("bed")} Stays</h4>
    <ul class="ph-stays" data-ph-stays></ul>
  </section>
  <section data-ph-people-box hidden>
    <h4>${icon("users")} Uploaded by</h4>
    <ul class="ph-stays" data-ph-people></ul>
  </section>
  <section>
    <details data-ph-folders open>
    <summary><h4>${icon("folder")} Photo folders ${icon("chevronDown")}</h4></summary>
    <p class="hint">The photos and videos of this trip. Each can be a Google Drive folder or a folder on this computer.</p>
    <ul class="ph-sources" data-ph-sources></ul>
    <div class="drive-add">
      <button type="button" class="drive-tile" data-ph-add><span class="dt-ic">${icon("plus")}</span><span class="dt-text"><b>Add a folder</b><span>From this computer or your Google Drive</span></span></button>
      <button type="button" class="link-btn drive-paste-btn" data-ph-paste>${icon("link")} Or paste a link or path</button>
    </div>
    <p class="hint" data-ph-how>Photos and videos in it and its folders. From this computer they're read from the disk; nothing is uploaded.</p>
    <p class="hint ph-err" data-ph-err hidden></p>
    <p class="hint" data-ph-heic hidden>iPhone HEIC pictures can't be shown by browsers, so they're skipped. Export them as JPEG to include them.</p>
    </details>
  </section>
  <section>
    <h4>${icon("layers")} On the map</h4>
    <label class="ph-check"><input type="checkbox" data-ph-on> Show the photos on the map</label>
    <label class="ph-check" title="A photo with no GPS goes where your photos with GPS from a few minutes before or after were taken; without those, to the stop your plan has you at then. It's drawn with a dashed border"><input type="checkbox" data-ph-guess> Place photos without a location by their time</label>
  </section>
  </div>
  <button type="button" class="ph-refresh" data-ph-refresh title="Ask Google again and read the folders again (a Drive list is kept for an hour)">${icon("refresh")} Refresh all</button>
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
  const fold = q<HTMLDetailsElement>("[data-ph-folders]");
  fold.addEventListener("toggle", () => { if (folders().length) setView({ foldersShut: !fold.open }); });
  q<HTMLButtonElement>("[data-ph-refresh]").onclick = () => loadMissing(true);
}

/** Opens the window with the trip's photos and their settings (`place`: at Place on map, showing "By others" when it's a
 *  trip several people work on). */
export function openPhotosView(mode?: "place", photo?: string) {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "keys-dialog photos-dialog";
    dlg.innerHTML = `<div class="pl-head"><button type="button" class="icon-btn" data-ph-toggle-side></button><h2>${icon("images")} Photos</h2><span class="hint" data-ph-count></span>
        <div class="segs ph-modes"><button type="button" class="seg" data-ph-mode="gallery">Gallery</button><button type="button" class="seg" data-ph-mode="place" title="Drag photos onto the map to say where they were taken">Place on map</button></div>
        <button type="button" class="icon-btn ph-full-btn" data-ph-full></button>
        <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div>
      <div class="ph-wrap">${SIDE()}<div class="ph-main"><div class="ph-body"></div><nav class="ph-time" aria-label="Jump to a day" hidden></nav></div></div><div class="pp-wrap"></div>`;
    document.body.append(dlg);
    // A click on the dimmed area around it closes it, like the other windows.
    closeOnBackdrop(dlg);
    wireSide(dlg);
    timeline = photoTimeline(dlg.querySelector<HTMLElement>(".ph-time")!, dlg.querySelector<HTMLElement>(".ph-body")!);
    tip = photoTip(dlg, dlg.querySelector<HTMLElement>(".ph-body")!);
    tool = placeTool(dlg.querySelector<HTMLElement>(".pp-wrap")!);
    dlg.querySelectorAll<HTMLButtonElement>("[data-ph-mode]").forEach((b) => { b.onclick = () => setPlacing(b.dataset.phMode === "place"); });
    dlg.querySelector<HTMLButtonElement>("[data-ph-toggle-side]")!.onclick = () => {
      if (phone.matches) { phoneSide = !phoneSide; applyView(); }
      else setView({ noSide: !dlg!.classList.contains("no-side") });
    };
    phone.addEventListener("change", applyView);
    dlg.querySelector<HTMLButtonElement>("[data-ph-full]")!.onclick = () => setView({ full: !view.full });
    // Sources finishing their load, or being added or taken off, show here as they happen.
    onPhotosChange(render);
  }
  phoneSide = false;
  if (!dlg.open) dlg.showModal();
  // Sources not loaded yet (the layer on the map may be off).
  loadMissing();
  if (mode === "place") { placing = true; if (!photo) tool!.showOthers(); }
  render();
  if (placing) tool!.show();
  // A photo from Changes: History open at it, and the map there.
  if (photo) tool!.focus(photo);
}
