// The trip's photos in a window. On the left, everything to set up: where the photos come from (Google Drive folders and
// folders on this computer, as many as the trip has) and how they show on the map. On the right, every photo laid out by
// the day of the trip it was taken on (the others by date), with or without a spot on the map. Click one to go through
// them big (arrows, a strip along the bottom); the pin on a photo moves the map to where it was taken.
import { api, closeOnBackdrop, esc } from "../core/dom";
import { fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { session, state } from "../core/state";
import { map } from "../map/map";
import {
  type Placed, addLocalFolder, addPhotosFolder, allPhotos, duration, folders, isPhotosGuess, isPhotosOn, loadMissing, onPhotosChange,
  photosState, removePhotosFolder, setPhotosFolderShown, setPhotosGuess, setPhotosOn, thumbTag, viewItem,
} from "../map/photos";
import { showGallery } from "../core/lightbox";
import { highlights } from "./preview-data";

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
  if (!folders().length) body = `<p class="ph-empty">No photo folders for this trip yet.<br><span class="hint">Add a Google Drive folder, or a folder from this computer, on the left.</span></p>`;
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
        map?.flyTo([p.lat!, p.lng!], Math.max(map.getZoom(), 17), { duration: .6 });
        return;
      }
      showGallery(all.map(viewItem), +t.dataset.i!);
    };
  });
}

const render = () => { renderSide(); renderMain(); };

/** The sidebar's own markup, made once. */
const SIDE = () => `<aside class="ph-side">
  <section>
    <h4>Photo folders</h4>
    <p class="hint">The photos and videos of this trip. Each can be a Google Drive folder or a folder on this computer.</p>
    <ul class="ph-sources" data-ph-sources></ul>
  </section>
  <section>
    <h4>Add a Google Drive folder</h4>
    <form data-ph-drive>
      <input type="url" placeholder="Link to the folder" autocomplete="off" spellcheck="false">
      <button class="btn">Add</button>
    </form>
    <p class="hint">Share the folder as “Anyone with the link”, then paste its link. Needs a Google API key (Settings → Planning).</p>
    <p class="hint ph-err" data-ph-drive-err hidden></p>
  </section>
  <section>
    <h4>Add a folder from this computer</h4>
    <form data-ph-local>
      <input type="text" placeholder="D:\\Photos\\Italy" autocomplete="off" spellcheck="false">
      <button class="btn">Add</button>
    </form>
    <button type="button" class="btn" data-ph-pick>${icon("folder")} Choose folder…</button>
    <p class="hint">Photos and videos in it and its subfolders. The planner reads them from the disk; nothing is uploaded.</p>
    <p class="hint ph-err" data-ph-local-err hidden></p>
    <p class="hint" data-ph-heic hidden>iPhone HEIC pictures can't be shown by browsers, so they're skipped. Export them as JPEG to include them.</p>
  </section>
  <section>
    <h4>On the map</h4>
    <label class="ph-check"><input type="checkbox" data-ph-on> Show the photos on the map</label>
    <label class="ph-check" title="A photo with no GPS goes where your plan has you at the time it was taken (its day, and the stop you were at); it's drawn with a dashed border"><input type="checkbox" data-ph-guess> Place photos without a location by their time</label>
  </section>
  <section><button type="button" class="btn" data-ph-refresh title="Ask Google again and read the folders again (a Drive list is kept for an hour)">Refresh all</button></section>
</aside>`;

/** Wires what's in the sidebar for good (the fields and buttons that stay). */
function wireSide(d: HTMLDialogElement) {
  const q = <T extends HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const say = (sel: string, text: string) => { const el = q(sel); el.textContent = text; el.hidden = !text; };
  const driveForm = q<HTMLFormElement>("[data-ph-drive]"), localForm = q<HTMLFormElement>("[data-ph-local]");
  driveForm.onsubmit = (e) => {
    e.preventDefault();
    const input = driveForm.querySelector<HTMLInputElement>("input")!, why = addPhotosFolder(input.value);
    say("[data-ph-drive-err]", why);
    if (!why) input.value = "";
  };
  localForm.onsubmit = (e) => {
    e.preventDefault();
    const input = localForm.querySelector<HTMLInputElement>("input")!, why = addLocalFolder(input.value);
    say("[data-ph-local-err]", why);
    if (!why) input.value = "";
  };
  // The system's own folder dialog, on this computer (a web page can't give a folder's path).
  const pick = q<HTMLButtonElement>("[data-ph-pick]");
  pick.onclick = async () => {
    pick.disabled = true; say("[data-ph-local-err]", "");
    const label = pick.innerHTML;
    pick.textContent = "Waiting for the folder dialog…";
    try {
      const r = await api<{ path: string }>("/api/pick-folder", { method: "POST", body: "{}" });
      if (r.path) say("[data-ph-local-err]", addLocalFolder(r.path));
    } catch (e) { say("[data-ph-local-err]", (e as Error).message); }
    finally { pick.disabled = false; pick.innerHTML = label; }
  };
  q<HTMLInputElement>("[data-ph-on]").onchange = (e) => setPhotosOn((e.target as HTMLInputElement).checked);
  q<HTMLInputElement>("[data-ph-guess]").onchange = (e) => setPhotosGuess((e.target as HTMLInputElement).checked);
  q<HTMLButtonElement>("[data-ph-refresh]").onclick = () => loadMissing(true);
}

/** Opens the window with the trip's photos and their settings. */
export function openPhotosView() {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "keys-dialog photos-dialog";
    dlg.innerHTML = `<div class="pl-head"><h2>${icon("images")} Photos</h2><span class="hint" data-ph-count></span>
        <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div>
      <div class="ph-wrap">${SIDE()}<div class="ph-body"></div></div>`;
    document.body.append(dlg);
    // A click on the dimmed area around it closes it, like the other windows.
    closeOnBackdrop(dlg);
    wireSide(dlg);
    // Sources finishing their load, or being added or taken off, show here as they happen.
    onPhotosChange(render);
  }
  if (!dlg.open) dlg.showModal();
  // Sources not loaded yet (the layer on the map may be off).
  loadMissing();
  render();
}
