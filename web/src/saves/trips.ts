// Your trips: every saved trip as a card with a sketch of its route, or as a table. Search, coming up / past / no
// dates, sorting (by trip date the past ones are grouped by year: a memory lane), and open, rename and delete. New
// trip, Import and Save are here too. With sync (Settings → Sync): which trips are in Drive folders (a cloud on the card,
// a column in the table), who shared each, the trips in the folders that aren't on this computer yet (open or download
// them), and filters by where a trip is, its folder and who shared it.
import type { AppState } from "../core/state";
import type { RemoteTripCard, SyncStatus, TripCard } from "../../../shared/types";
import { $, $$, api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { type Filter, type Sort, groupTrips, hueOf, pickTrips, previewSvg, whenLabel, whenOf } from "./trip-cards";
import { clearTripMaps, showTripMaps } from "./trip-maps";
import { folderLabel, isOwner, loadSyncStatus, onSyncStatus, ownerName, setSyncStatus, syncNow, syncReady, syncStatus } from "./sync-client";
import { openSyncPanel } from "./sync-panel";
import { askConfirm, askText } from "../core/ask";

const VIEW_KEY = "trip-planner-trips-view";
let cards: TripCard[] | null = null, loadError = "";
/** Trips in the sync folders that aren't on this computer yet. */
let remote: RemoteTripCard[] = [];
let query = "", filter: Filter = "all", sort: Sort = "date-desc";
/** Where: "all", "local" (only on this computer), "synced", "remote" (in a folder, not downloaded), or "f:<folder id>".
 *  By: "" (anyone), "me", or "o:<email>" (shared by them). */
let where = "all", by = "";
let view: "grid" | "table" = localStorage.getItem(VIEW_KEY) === "table" ? "table" : "grid";
let animate = true;

/** What the dialog does with a trip: the sidebar's functions (saves.ts), handed in to keep the imports one way. */
interface Actions {
  open: (name: string) => Promise<void>;
  afterChange: (renamed?: { from: string; to: string }) => Promise<void>;
}
let actions: Actions;

const dialog = () => $<HTMLDialogElement>("#tripsDialog");
const today = () => new Date().toLocaleDateString("sv");

const dateRange = (c: TripCard) => {
  if (!c.start) return "";
  const f = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { ...o, timeZone: "UTC" });
  const sameYear = c.start.slice(0, 4) === (c.end || c.start).slice(0, 4);
  return `${f(c.start, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} – ${f(c.end || c.start, { month: "short", day: "numeric", year: "numeric" })}`;
};
const cityLine = (c: TripCard, max = 4) => {
  // The home address at both ends ("Home"): shown once, at the start.
  const towns = c.cities.filter((t, i) => !(i === c.cities.length - 1 && t === c.cities[0] && c.cities.length > 2));
  return esc(towns.slice(0, max).join(" → ")) + (towns.length > max ? ` <span class="tc-more">+${towns.length - max}</span>` : "");
};
const countryPills = (c: TripCard) => c.countries.map((x) => `<span class="tc-cc" title="${esc(x.country)}">${esc(x.cc.toUpperCase())}</span>`).join("");
const planText = (c: TripCard) => (c.days ? `<span class="tc-plan ok">${icon("check")} Planned · ${c.days} day${c.days === 1 ? "" : "s"}</span>` : `<span class="tc-plan">No plan yet</span>`);

function cardHtml(c: TripCard, i: number) {
  const w = whenOf(c, today()), current = c.name === state.saveName;
  return `<article class="trip-card ${w}${current ? " current" : ""}" data-name="${esc(c.name)}" tabindex="0" style="--h:${hueOf(c.name)};--i:${Math.min(i, 14)}">
    <div class="tc-preview">${previewSvg(c)}${c.route.length || c.dots.length ? `<div class="tc-map" data-map="${esc(c.name)}"></div>` : ""}
      <span class="tc-when">${w === "past" ? icon("history") : w === "upcoming" ? icon("hourglass") : w === "now" ? icon("plane") : icon("calendar")} ${esc(whenLabel(c, today()))}</span>
      ${current ? `<span class="tc-current">Open now</span>` : ""}
      ${cloudBadge(c.name)}
      <span class="tc-tools">${syncStatus ? syncButton(c.name, "tc-tool") : ""}<button type="button" class="tc-tool" data-copy title="Make a copy">${icon("copy")}</button><button type="button" class="tc-tool" data-rename title="Rename">${icon("pencil")}</button><button type="button" class="tc-tool" data-delete title="Delete">${icon("trash")}</button></span>
    </div>
    <div class="tc-body">
      <h4>${esc(c.name)}</h4>
      ${c.title && c.title !== c.name ? `<div class="tc-title">${esc(c.title)}</div>` : ""}
      <div class="tc-cities">${cityLine(c) || `<span class="hint">No stays yet</span>`}</div>
      <div class="tc-meta">${c.start ? `<span>${icon("calendar")} ${esc(dateRange(c))}</span>` : ""}${c.nights ? `<span>${icon("bed")} ${c.nights} night${c.nights === 1 ? "" : "s"}</span>` : ""}<span>${icon("users")} ${c.travelers}</span></div>
      <div class="tc-foot">${planText(c)}<span class="tc-ccs">${countryPills(c)}</span></div>
      ${syncLine(c.name)}
    </div>
  </article>`;
}

/** The Sync button on a trip: a filled cloud when it syncs, an outline when it doesn't (yet). */
function syncButton(name: string, cls: string) {
  const info = syncStatus?.trips[name];
  const title = info ? `Synced with ${info.folders.map(folderLabel).join(", ")}: change where it syncs` : "Sync with Google Drive folders";
  return `<button type="button" class="${cls}${info ? " synced" : ""}" data-sync title="${esc(title)}">${icon("cloud")}</button>`;
}

/** A synced trip's mark in the card's corner: the cloud and its folders. */
function cloudBadge(name: string) {
  const info = syncStatus?.trips[name];
  if (!info) return "";
  const where = info.folders.map(folderLabel).join(", ");
  return `<span class="tc-cloud" title="In Google Drive: ${esc(where)}">${icon("cloud")} ${esc(where)}</span>`;
}

/** How a trip syncs: who shared it (and edit or view), and a clash to decide. */
function syncLine(name: string) {
  const info = syncStatus?.trips[name];
  if (!info) return "";
  const who = info.share && !info.mine ? `Shared by ${esc(ownerName(info.share))}` : "Shared by you";
  const mode = info.share?.mode === "view" ? (info.mine ? " · others can only view" : ` · <span class="tc-view">${icon("eye")} view only</span>`) : "";
  const clashes = info.conflicts.map((x) => `<div class="tc-clash">${icon("warn")} Changed here and in ${esc(folderLabel(x.folder))}${x.by ? ` by ${esc(x.by)}` : ""}${x.at ? ` (${esc(new Date(x.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }))})` : ""}. Keep which?
      <span><button type="button" class="btn" data-keep="mine" data-folder="${esc(x.folder)}">This computer's</button><button type="button" class="btn" data-keep="theirs" data-folder="${esc(x.folder)}">Drive's</button></span></div>`).join("");
  return `<div class="tc-sync">${icon("users")} ${who}${mode}${info.error ? ` <span class="bad" title="${esc(info.error)}">${icon("warn")}</span>` : ""}</div>${clashes}`;
}

/** Where a trip is, for the filters: its folders, whether it's on this computer, and who shared it. */
function placeOf(c: TripCard | RemoteTripCard) {
  if ("fileId" in c) return { local: false, synced: true, folders: [c.folder], owner: c.share?.owner || "", mine: isOwner(c.share) && !!c.share?.owner };
  const info = syncStatus?.trips[c.name];
  return { local: true, synced: !!info, folders: info?.folders || [], owner: info?.share?.owner || "", mine: !!info?.mine };
}
function passes(c: TripCard | RemoteTripCard) {
  const p = placeOf(c);
  const okWhere = where === "all" || (where === "local" && p.local && !p.synced) || (where === "synced" && p.local && p.synced)
    || (where === "remote" && !p.local) || (where.startsWith("f:") && p.folders.includes(where.slice(2)));
  const okBy = !by || (by === "me" ? p.synced && p.mine : by.startsWith("o:") && p.owner.toLowerCase() === by.slice(2));
  return okWhere && okBy;
}

/** The Where and Shared by choices, shown once there's anything synced. */
function drawFilters() {
  const box = $("#tripsSyncFilters"), s = syncStatus;
  const people = new Map<string, string>();
  for (const info of Object.values(s?.trips || {})) if (info.share?.owner && !info.mine) people.set(info.share.owner.toLowerCase(), ownerName(info.share));
  for (const c of remote) if (c.share?.owner && !isOwner(c.share)) people.set(c.share.owner.toLowerCase(), ownerName(c.share));
  const show = !!s && (s.folders.length > 0 || Object.keys(s.trips).length > 0);
  box.hidden = !show;
  if (!show) { where = "all"; by = ""; return; }
  const opt = (v: string, label: string, now: string) => `<option value="${esc(v)}"${v === now ? " selected" : ""}>${esc(label)}</option>`;
  box.innerHTML = `<select id="tripsWhere" title="Where the trips are">${opt("all", "Everywhere", where)}${opt("local", "Only on this computer", where)}${opt("synced", "Synced with Google Drive", where)}${opt("remote", "In Drive, not downloaded", where)}
      ${s!.folders.length ? `<optgroup label="Google Drive folder">${s!.folders.map((f) => opt(`f:${f.id}`, f.label, where)).join("")}</optgroup>` : ""}</select>
    <select id="tripsBy" title="Who shared them">${opt("", "Shared by anyone", by)}${opt("me", "Shared by me", by)}${[...people].map(([e, n]) => opt(`o:${e}`, `Shared by ${n}`, by)).join("")}</select>`;
  $<HTMLSelectElement>("#tripsWhere").onchange = (e) => { where = (e.target as HTMLSelectElement).value; animate = true; render(); };
  $<HTMLSelectElement>("#tripsBy").onchange = (e) => { by = (e.target as HTMLSelectElement).value; animate = true; render(); };
}

/** Sync now: looks at the sync folders straight away (it also happens by itself every few minutes), and says how it went. */
async function syncAll(button: HTMLButtonElement) {
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} Syncing…`;
  try {
    const s = await api<SyncStatus>("/api/sync/now", { method: "POST" });
    setSyncStatus(s);
    await actions.afterChange();
    await load();
    const bad = s.folders.find((f) => f.error), trips = Object.values(s.trips);
    toast(s.error ? `Sync failed: ${s.error}`
      : bad ? `${bad.label}: ${bad.error}`
        : trips.some((x) => x.error) ? "Some trips couldn't be synced (see the warning on them)"
          : trips.some((x) => x.conflicts.length) ? "Synced. A trip changed in two places: choose which version to keep"
            : "Synced");
  } catch (e) { toast(`Sync failed: ${(e as Error).message}`); }
  finally { button.disabled = false; button.innerHTML = `${icon("refresh")} Sync now`; }
}

/** A trip in a sync folder that isn't on this computer: open it to get it here. */
function remoteHtml(c: RemoteTripCard, i: number) {
  return `<article class="trip-card remote" data-remote="${esc(c.fileId)}" data-folder="${esc(c.folder)}" tabindex="0" style="--h:${hueOf(c.name)};--i:${Math.min(i, 14)}">
    <div class="tc-preview">${previewSvg(c)}${c.route.length || c.dots.length ? `<div class="tc-map" data-map="${esc(mapKey(c))}"></div>` : ""}<span class="tc-when">${icon(whenOf(c, today()) === "past" ? "history" : "calendar")} ${esc(whenLabel(c, today()))}</span>
      <span class="tc-cloud remote" title="In Google Drive (${esc(folderLabel(c.folder))}), not on this computer yet">${icon("cloud")} ${esc(folderLabel(c.folder))}</span></div>
    <div class="tc-body">
      <h4>${esc(c.name)}</h4>
      <div class="tc-cities">${cityLine(c) || `<span class="hint">No stays yet</span>`}</div>
      <div class="tc-meta">${c.start ? `<span>${icon("calendar")} ${esc(dateRange(c))}</span>` : ""}${c.nights ? `<span>${icon("bed")} ${c.nights} night${c.nights === 1 ? "" : "s"}</span>` : ""}<span>${icon("users")} ${c.travelers}</span></div>
      <div class="tc-sync">${icon("users")} ${c.share?.owner ? (isOwner(c.share) ? "Shared by you" : `Shared by ${esc(ownerName(c.share))}`) : c.by ? `Put there by ${esc(c.by)}` : "In the folder"}${c.share?.mode === "view" && !isOwner(c.share) ? ` · <span class="tc-view">${icon("eye")} view only</span>` : ""}</div>
      <div class="tc-foot"><span class="tc-plan">Not on this computer</span><button type="button" class="btn" data-download title="Get it onto this computer without opening it (it then works offline and stays in step)">${icon("download")} Download</button></div>
    </div>
  </article>`;
}

/** The trips in the sync folders that aren't here, under the saved ones. */
function remoteSection(list: RemoteTripCard[]) {
  if (!list.length) return "";
  if (view === "table") return `<h3 class="trips-group">In Google Drive, not downloaded<span>${list.length}</span></h3>${tableHtml(list)}`;
  return `<h3 class="trips-group">In Google Drive, not downloaded<span>${list.length}</span></h3>
    <p class="hint trips-remote-hint">Open one, or download it to have it on this computer (it then works offline and stays in step with its folder).${list.length > 1 ? ` <button type="button" class="link-btn" data-download-all>${icon("download")} Download all ${list.length}</button>` : ""}</p>
    <div class="trips-grid">${list.map(remoteHtml).join("")}</div>`;
}

/** The remote trips that match the search and the filters. */
function pickRemote() {
  if (where === "local" || where === "synced") return [];
  return pickTrips(remote, { query, filter, sort, today: today() }).filter(passes) as RemoteTripCard[];
}

/** The key of a trip's map box (a trip in Drive by its file: it may share a name with one here). */
const mapKey = (c: TripCard | RemoteTripCard) => ("fileId" in c ? `drive:${c.fileId}` : c.name);

/** Where a trip is, for the table. */
function whereCell(c: TripCard | RemoteTripCard) {
  const p = placeOf(c);
  if (!p.synced) return `<span class="hint">This computer</span>`;
  const owner = "fileId" in c ? c.share : syncStatus?.trips[c.name]?.share;
  return `<span class="tt-where">${icon("cloud")} ${esc(p.folders.map(folderLabel).join(", "))}</span><div class="hint">${p.local ? "" : "Not downloaded · "}${owner?.owner ? (isOwner(owner) ? "by you" : `by ${esc(ownerName(owner))}`) : ""}${owner?.mode === "view" && !isOwner(owner) ? " · view only" : ""}</div>`;
}

function tableHtml(list: (TripCard | RemoteTripCard)[]) {
  const th = (s: Sort | "", label: string) => s ? `<th><button type="button" class="tt-sort${sort === s || (s === "date-desc" && sort === "date-asc") ? " on" : ""}" data-sort="${s}">${label}${sort === s ? " ↓" : s === "date-desc" && sort === "date-asc" ? " ↑" : ""}</button></th>` : `<th>${label}</th>`;
  return `<table class="trips-table"><thead><tr><th></th>${th("name", "Trip")}${th("date-desc", "When")}${th("length", "Nights")}${th("", "Countries")}${th("", "Plan")}${syncStatus?.folders.length ? th("", "Where") : ""}${th("recent", "Saved")}<th></th></tr></thead><tbody>
    ${list.map((c, i) => `<tr class="trip-row ${whenOf(c, today())}${c.name === state.saveName && !("fileId" in c) ? " current" : ""}" ${"fileId" in c ? `data-remote="${esc(c.fileId)}" data-folder="${esc(c.folder)}"` : `data-name="${esc(c.name)}"`} tabindex="0" style="--h:${hueOf(c.name)};--i:${Math.min(i, 20)}">
      <td class="tt-thumb"><div class="tt-map">${previewSvg(c, 112, 64, 8)}${c.route.length || c.dots.length ? `<div class="tc-map" data-map="${esc(mapKey(c))}"></div>` : ""}</div></td>
      <td><div class="tt-name"><b>${esc(c.name)}</b>${c.name === state.saveName && !("fileId" in c) ? `<span class="tt-open">Open now</span>` : ""}</div><div class="hint">${cityLine(c, 5)}</div></td>
      <td>${c.start ? esc(dateRange(c)) : `<span class="hint">No dates</span>`}<div class="hint">${esc(whenLabel(c, today()))}</div></td>
      <td>${c.nights || "–"}</td><td><span class="tc-ccs">${countryPills(c)}</span></td><td>${planText(c)}</td>
      ${syncStatus?.folders.length ? `<td>${whereCell(c)}</td>` : ""}
      <td class="hint">${new Date(c.savedAt).toLocaleDateString()}</td>
      <td class="tt-tools">${"fileId" in c ? `<button type="button" class="icon-btn" data-download title="Download it to this computer">${icon("download")}</button>`
        : `${syncStatus ? syncButton(c.name, "icon-btn") : ""}<button type="button" class="icon-btn" data-copy title="Make a copy">${icon("copy")}</button><button type="button" class="icon-btn" data-rename title="Rename">${icon("pencil")}</button><button type="button" class="icon-btn" data-delete title="Delete">${icon("trash")}</button>`}</td>
    </tr>`).join("")}</tbody></table>`;
}

/** Totals for the header: trips, countries, nights away (a little memory lane). */
function stats(list: TripCard[]) {
  const ccs = new Set(list.flatMap((c) => c.countries.map((x) => x.cc)));
  const nights = list.reduce((n, c) => n + c.nights, 0);
  return `${list.length} trip${list.length === 1 ? "" : "s"}${ccs.size ? ` · ${ccs.size} countr${ccs.size === 1 ? "y" : "ies"}` : ""}${nights ? ` · ${nights} nights away` : ""}`;
}

function render() {
  const body = $("#tripsBody");
  clearTripMaps();
  $("#tripsSyncNow").hidden = !syncReady();
  $("#tripsMeta").textContent = cards ? stats(cards) : "";
  $$<HTMLButtonElement>("#tripsDialog [data-filter]").forEach((b) => b.classList.toggle("on", b.dataset.filter === filter));
  $$<HTMLButtonElement>("#tripsDialog [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $<HTMLSelectElement>("#tripsSort").value = sort;
  if (loadError) { body.innerHTML = `<p class="error-text">${icon("warn")} ${esc(loadError)}</p>`; return; }
  if (!cards) { body.innerHTML = `<div class="trips-grid">${Array.from({ length: 6 }, () => `<div class="trip-card skeleton"><div class="tc-preview"></div><div class="tc-body"><i></i><i></i><i></i></div></div>`).join("")}</div>`; return; }
  drawFilters();
  const list = where === "remote" ? [] : pickTrips(cards, { query, filter, sort, today: today() }).filter(passes);
  body.classList.toggle("animate", animate);
  animate = false;
  const notices = (syncStatus?.notices || []).length ? `<div class="trips-notice">${icon("info")}<div>${syncStatus!.notices.map((n) => `<p>${esc(n)}</p>`).join("")}</div><button type="button" class="icon-btn" data-dismiss title="OK">${icon("x")}</button></div>` : "";
  if (!cards.length && !remote.length) {
    body.innerHTML = notices + `<div class="trips-empty">${icon("compass")}<b>No saved trips yet</b><p>Save the trip you're working on, or import one someone shared. They all collect here, upcoming ones and memories alike.</p></div>`;
    wire(body);
    return;
  }
  const others = remoteSection(pickRemote());
  if (!list.length && !others) { body.innerHTML = notices + `<div class="trips-empty">${icon("search")}<b>Nothing matches</b><p>Try another word, or show all trips.</p></div>`; wire(body); return; }
  body.innerHTML = notices + (!list.length ? "" : view === "table" ? tableHtml(list)
    : groupTrips(list, sort, today()).map((g) => `${g.label ? `<h3 class="trips-group">${esc(g.label)}<span>${g.cards.length}</span></h3>` : ""}
        <div class="trips-grid">${g.cards.map(cardHtml).join("")}</div>`).join("")) + others;
  wire(body);
  showTripMaps(body, [...list, ...pickRemote()], mapKey);
  if (cards.length || remote.length) $("#tripsMeta").textContent = stats(cards) + (remote.length ? ` · ${remote.length} more in Drive` : "");
}

function wire(body: HTMLElement) {
  for (const el of $$<HTMLElement>("[data-name]", body)) {
    const name = el.dataset.name!;
    el.onclick = (e) => { if (!(e.target as HTMLElement).closest("button")) openTrip(name); };
    el.onkeydown = (e) => { if (e.key === "Enter" && e.target === el) openTrip(name); };
    el.querySelector<HTMLButtonElement>("[data-rename]")!.onclick = () => rename(name);
    el.querySelector<HTMLButtonElement>("[data-copy]")!.onclick = () => copyTrip(name);
    el.querySelector<HTMLButtonElement>("[data-delete]")!.onclick = () => remove(name);
    el.querySelector<HTMLButtonElement>("[data-sync]")?.addEventListener("click", () => openSyncPanel(name, () => load()));
    $$<HTMLButtonElement>("[data-keep]", el).forEach((b) => { b.onclick = () => decide(name, b.dataset.folder!, b.dataset.keep as "mine" | "theirs"); });
  }
  for (const el of $$<HTMLElement>("[data-remote]", body)) {
    const go = () => openRemote(el.dataset.folder!, el.dataset.remote!);
    el.onclick = (e) => { if (!(e.target as HTMLElement).closest("button")) go(); };
    el.onkeydown = (e) => { if (e.key === "Enter" && e.target === el) go(); };
    el.querySelector<HTMLButtonElement>("[data-download]")?.addEventListener("click", () => download([{ folder: el.dataset.folder!, fileId: el.dataset.remote! }]));
  }
  body.querySelector<HTMLButtonElement>("[data-download-all]")?.addEventListener("click", () => download(pickRemote().map((c) => ({ folder: c.folder, fileId: c.fileId }))));
  body.querySelector<HTMLButtonElement>("[data-dismiss]")?.addEventListener("click", async () => { setSyncStatus(await api<SyncStatus>("/api/sync/notices", { method: "POST" }).catch(() => syncStatus)); render(); });
  $$<HTMLButtonElement>("[data-sort]", body).forEach((b) => {
    b.onclick = () => { const s = b.dataset.sort as Sort; sort = s === "date-desc" && sort === "date-desc" ? "date-asc" : s; render(); };
  });
}

/** A clash: which version to keep (the other is kept as a version of the trip, so it can be got back). */
async function decide(name: string, folder: string, keep: "mine" | "theirs") {
  const yes = await askConfirm(keep === "mine"
    ? { title: "Keep this computer's version?", text: `It goes to ${folderLabel(folder)} for “${name}”. Drive's version is kept as an earlier version (Recover…).`, ok: "Keep this computer's" }
    : { title: "Take Drive's version?", text: `From ${folderLabel(folder)}, for “${name}”. This computer's version is kept as an earlier version (Recover…).`, ok: "Take Drive's" });
  if (!yes) return;
  try {
    setSyncStatus(await api<SyncStatus>("/api/sync/resolve", { method: "POST", body: JSON.stringify({ name, folder, keep }) }));
    // The trip on screen shows Drive's version.
    if (keep === "theirs" && state.saveName === name) await actions.open(name);
    await load();
    toast(keep === "mine" ? "Kept this computer's version" : "Took Drive's version");
  } catch (e) { toast((e as Error).message); }
}

/** Gets trips from the sync folders onto this computer, without opening them. */
async function download(list: { folder: string; fileId: string }[]) {
  let got = 0;
  for (const x of list) {
    try { await api("/api/sync/open", { method: "POST", body: JSON.stringify(x) }); got++; }
    catch (e) { toast((e as Error).message); }
  }
  await loadSyncStatus();
  await actions.afterChange();
  await load();
  if (got) toast(got === 1 ? "Downloaded: it's on this computer now, and stays in step with its folder" : `Downloaded ${got} trips`);
}

/** Gets a trip from a sync folder onto this computer and opens it. */
async function openRemote(folder: string, fileId: string) {
  try {
    const { name } = await api<{ name: string }>("/api/sync/open", { method: "POST", body: JSON.stringify({ folder, fileId }) });
    await actions.open(name);
    dialog().close();
    loadSyncStatus();
  } catch (e) { toast((e as Error).message); }
}

async function openTrip(name: string) {
  try { await actions.open(name); dialog().close(); }
  catch (e) { toast((e as Error).message); }
}

/** A save name from any text, as the server keeps it: letters, numbers, spaces, - and _. */
const cleanName = (s: string) => s.replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
/** Why a name can't be used ("" when it can): another trip has it (`except`: the trip being renamed may keep its own). */
const nameProblem = (except = "") => {
  const taken = new Set((cards || []).map((c) => c.name.toLowerCase()).filter((n) => n !== except.toLowerCase()));
  return (v: string) => { const n = cleanName(v); return !n ? "Use letters or numbers." : taken.has(n.toLowerCase()) ? `There's already a trip called “${n}”.` : ""; };
};
/** A name no trip has yet: "Kyoto copy", "Kyoto copy 2"… */
const freeName = (base: string) => {
  const taken = new Set((cards || []).map((c) => c.name.toLowerCase()));
  let n = cleanName(base);
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${cleanName(base)} ${i}`;
  return n;
};

/** Make a copy: the trip under a new name (one no other trip has), as a trip of its own: not synced with the folders the
 *  original syncs with, and with no history of its own yet. */
async function copyTrip(from: string) {
  const to = await askText({ title: `Copy “${from}”`, text: "A trip of its own, to change as you like. The original stays as it is (and keeps syncing, if it does).", label: "Name of the copy", value: freeName(`${from} copy`), ok: "Make a copy", required: true, validate: nameProblem() });
  if (!to) return;
  try {
    const { sync: _s, edits: _e, log: _l, ...data } = await api<AppState>(`/api/saves/${encodeURIComponent(from)}`);
    const { name } = await api<{ name: string }>(`/api/saves/${encodeURIComponent(cleanName(to))}`, { method: "PUT", body: JSON.stringify({ ...data, saveName: cleanName(to) }) });
    await actions.afterChange();
    await load();
    toast(`Copied as "${name}"`);
  } catch (e) { toast((e as Error).message); }
}

async function rename(from: string) {
  // (Never onto another trip's name: that would write over it.)
  const to = await askText({ title: "Rename trip", label: "Name", value: from, ok: "Rename", required: true, validate: nameProblem(from) });
  if (!to || to === from) return;
  try {
    const data = await api<AppState>(`/api/saves/${encodeURIComponent(from)}`);
    const { name } = await api<{ name: string }>(`/api/saves/${encodeURIComponent(to)}`, { method: "PUT", body: JSON.stringify({ ...data, saveName: to }) });
    if (name !== from) await api(`/api/saves/${encodeURIComponent(from)}`, { method: "DELETE" });
    if (state.saveName === from) { state.saveName = name; save(); }
    await actions.afterChange({ from, to: name });
    await load();
    toast(`Renamed to "${name}"`);
  } catch (e) { toast((e as Error).message); }
}

async function remove(name: string) {
  if (!await askConfirm({ title: `Delete “${name}”?`, text: syncStatus?.trips[name] ? "It's removed from this computer; the copy in Google Drive stays. Its last version is kept (Recover…)." : "Its last version is kept, so it can be got back (Your trips → Recover…).", ok: "Delete", danger: true })) return;
  await api(`/api/saves/${encodeURIComponent(name)}`, { method: "DELETE" });
  await actions.afterChange();
  await load();
  toast(`Deleted "${name}"`);
}

export async function load() {
  try {
    [cards, remote] = await Promise.all([api<TripCard[]>("/api/trips"), syncReady() ? api<RemoteTripCard[]>("/api/sync/remote").catch(() => []) : Promise.resolve([])]);
    loadError = "";
  }
  catch (e) { loadError = (e as Error).message; }
  if (dialog().open) render();
  return cards;
}

export function openTrips() {
  cards = null; animate = true;
  if (!dialog().open) dialog().showModal();
  render();
  // The sync folders are looked at now; what's new in them shows when that's done.
  loadSyncStatus().then(() => load()).then(() => syncNow()).then(() => { if (dialog().open) load(); });
  setTimeout(() => $<HTMLInputElement>("#tripsSearch").focus(), 50);
}

/** Closed: its maps go (and their tiles stop loading). */
const closed = () => clearTripMaps();

export function initTrips(a: Actions) {
  actions = a;
  // The Where and Shared by filters, next to the others (shown once there's something synced).
  const tools = document.querySelector(".trips-tools"), filters = document.createElement("div");
  filters.id = "tripsSyncFilters"; filters.className = "trips-sync-filters"; filters.hidden = true;
  tools?.insertBefore(filters, $("#tripsSort"));
  // Cards or table: up by the buttons, so the search and filters keep to one line.
  const segs = document.querySelector("#tripsDialog .view-segs");
  if (segs) $("#tripsDialog .trips-acts").prepend(segs);
  // Sync now, first of the buttons (there once there are sync folders).
  const now = document.createElement("button");
  now.type = "button"; now.id = "tripsSyncNow"; now.className = "btn"; now.hidden = true;
  now.title = "Look at the sync folders now: send your changes and get others'";
  now.innerHTML = `${icon("refresh")} Sync now`;
  now.onclick = () => syncAll(now);
  $("#tripsNew").before(now);
  onSyncStatus(() => { if (dialog().open && cards) render(); });
  dialog().addEventListener("close", closed);
  const search = $<HTMLInputElement>("#tripsSearch");
  search.oninput = () => { query = search.value; render(); };
  $$<HTMLButtonElement>("#tripsDialog [data-filter]").forEach((b) => { b.onclick = () => { filter = b.dataset.filter as Filter; animate = true; render(); }; });
  $$<HTMLButtonElement>("#tripsDialog [data-view]").forEach((b) => {
    b.onclick = () => { view = b.dataset.view as "grid" | "table"; localStorage.setItem(VIEW_KEY, view); animate = true; render(); };
  });
  $<HTMLSelectElement>("#tripsSort").onchange = (e) => { sort = (e.target as HTMLSelectElement).value as Sort; animate = true; render(); };
}
