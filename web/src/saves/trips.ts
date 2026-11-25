// Your trips: every saved trip as a card with a sketch of its route, or as a table. Search, coming up / past / no
// dates, sorting (by trip date the past ones are grouped by year: a memory lane), and open, rename and delete. New
// trip, Import and Save are here too.
import type { AppState } from "../core/state";
import type { RemoteTripCard, SyncStatus, TripCard } from "../../../shared/types";
import { $, $$, api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { type Filter, type Sort, groupTrips, hueOf, pickTrips, previewSvg, whenLabel, whenOf } from "./trip-cards";
import { clearTripMaps, showTripMaps } from "./trip-maps";
import { folderLabel, isOwner, loadSyncStatus, onSyncStatus, ownerName, setSyncStatus, syncNow, syncReady, syncStatus } from "./sync-client";
import { openSyncPanel } from "./sync-panel";

const VIEW_KEY = "trip-planner-trips-view";
let cards: TripCard[] | null = null, loadError = "";
/** Trips in the sync folders that aren't on this computer yet. */
let remote: RemoteTripCard[] = [];
let query = "", filter: Filter = "all", sort: Sort = "date-desc";
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
      <span class="tc-tools">${syncStatus ? `<button type="button" class="tc-tool" data-sync title="Sync with Drive folders">${icon("cloud")}</button>` : ""}<button type="button" class="tc-tool" data-rename title="Rename">${icon("pencil")}</button><button type="button" class="tc-tool" data-delete title="Delete">${icon("trash")}</button></span>
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

/** How a trip syncs: its folders, who shared it, and a clash to decide. */
function syncLine(name: string) {
  const info = syncStatus?.trips[name];
  if (!info) return "";
  const who = info.share && !info.mine ? ` · shared by ${esc(ownerName(info.share))}${info.share.mode === "view" ? ", view only" : ""}` : info.share?.mode === "view" ? " · others can only view" : "";
  const clashes = info.conflicts.map((x) => `<div class="tc-clash">${icon("warn")} Changed here and in ${esc(folderLabel(x.folder))}${x.by ? ` by ${esc(x.by)}` : ""}${x.at ? ` (${esc(new Date(x.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }))})` : ""}. Keep which?
      <span><button type="button" class="btn" data-keep="mine" data-folder="${esc(x.folder)}">This computer's</button><button type="button" class="btn" data-keep="theirs" data-folder="${esc(x.folder)}">Drive's</button></span></div>`).join("");
  return `<div class="tc-sync">${icon("cloud")} ${info.folders.map((f) => esc(folderLabel(f))).join(", ") || "Not syncing"}${who}${info.error ? ` <span class="bad" title="${esc(info.error)}">${icon("warn")}</span>` : ""}</div>${clashes}`;
}

/** A trip in a sync folder that isn't on this computer: open it to get it here. */
function remoteHtml(c: RemoteTripCard, i: number) {
  return `<article class="trip-card remote" data-remote="${esc(c.fileId)}" data-folder="${esc(c.folder)}" tabindex="0" style="--h:${hueOf(c.name)};--i:${Math.min(i, 14)}">
    <div class="tc-preview">${previewSvg(c)}<span class="tc-when">${icon("cloud")} ${esc(folderLabel(c.folder))}</span></div>
    <div class="tc-body">
      <h4>${esc(c.name)}</h4>
      <div class="tc-cities">${cityLine(c) || `<span class="hint">No stays yet</span>`}</div>
      <div class="tc-meta">${c.start ? `<span>${icon("calendar")} ${esc(dateRange(c))}</span>` : ""}${c.nights ? `<span>${icon("bed")} ${c.nights} night${c.nights === 1 ? "" : "s"}</span>` : ""}<span>${icon("users")} ${c.travelers}</span></div>
      <div class="tc-sync">${c.share && !isOwner(c.share) ? `Shared by ${esc(ownerName(c.share))}${c.share.mode === "view" ? ", view only" : ""}` : c.by ? `Last changed by ${esc(c.by)}` : ""}</div>
    </div>
  </article>`;
}

/** The trips in the sync folders that aren't here, under the saved ones. */
function remoteSection() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = remote.filter((c) => words.every((w) => `${c.name} ${c.cities.join(" ")} ${folderLabel(c.folder)}`.toLowerCase().includes(w)));
  if (!list.length) return "";
  return `<h3 class="trips-group">In your sync folders<span>${list.length}</span></h3><p class="hint trips-remote-hint">Open one to get it on this computer; it stays in step with its folder.</p>
    <div class="trips-grid">${list.map(remoteHtml).join("")}</div>`;
}

function tableHtml(list: TripCard[]) {
  const th = (s: Sort | "", label: string) => s ? `<th><button type="button" class="tt-sort${sort === s || (s === "date-desc" && sort === "date-asc") ? " on" : ""}" data-sort="${s}">${label}${sort === s ? " ↓" : s === "date-desc" && sort === "date-asc" ? " ↑" : ""}</button></th>` : `<th>${label}</th>`;
  return `<table class="trips-table"><thead><tr><th></th>${th("name", "Trip")}${th("date-desc", "When")}${th("length", "Nights")}${th("", "Countries")}${th("", "Plan")}${th("recent", "Saved")}<th></th></tr></thead><tbody>
    ${list.map((c, i) => `<tr class="trip-row ${whenOf(c, today())}${c.name === state.saveName ? " current" : ""}" data-name="${esc(c.name)}" tabindex="0" style="--h:${hueOf(c.name)};--i:${Math.min(i, 20)}">
      <td class="tt-thumb">${previewSvg(c, 96, 56, 8)}</td>
      <td><b>${esc(c.name)}</b>${c.name === state.saveName ? ` <span class="tc-current inline">Open now</span>` : ""}<div class="hint">${cityLine(c, 5)}</div></td>
      <td>${c.start ? esc(dateRange(c)) : `<span class="hint">No dates</span>`}<div class="hint">${esc(whenLabel(c, today()))}</div></td>
      <td>${c.nights || "–"}</td><td><span class="tc-ccs">${countryPills(c)}</span></td><td>${planText(c)}</td>
      <td class="hint">${new Date(c.savedAt).toLocaleDateString()}</td>
      <td class="tt-tools"><button type="button" class="icon-btn" data-rename title="Rename">${icon("pencil")}</button><button type="button" class="icon-btn" data-delete title="Delete">${icon("trash")}</button></td>
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
  $("#tripsMeta").textContent = cards ? stats(cards) : "";
  $$<HTMLButtonElement>("#tripsDialog [data-filter]").forEach((b) => b.classList.toggle("on", b.dataset.filter === filter));
  $$<HTMLButtonElement>("#tripsDialog [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $<HTMLSelectElement>("#tripsSort").value = sort;
  if (loadError) { body.innerHTML = `<p class="error-text">${icon("warn")} ${esc(loadError)}</p>`; return; }
  if (!cards) { body.innerHTML = `<div class="trips-grid">${Array.from({ length: 6 }, () => `<div class="trip-card skeleton"><div class="tc-preview"></div><div class="tc-body"><i></i><i></i><i></i></div></div>`).join("")}</div>`; return; }
  const list = pickTrips(cards, { query, filter, sort, today: today() });
  body.classList.toggle("animate", animate);
  animate = false;
  const notices = (syncStatus?.notices || []).length ? `<div class="trips-notice">${icon("info")}<div>${syncStatus!.notices.map((n) => `<p>${esc(n)}</p>`).join("")}</div><button type="button" class="icon-btn" data-dismiss title="OK">${icon("x")}</button></div>` : "";
  if (!cards.length && !remote.length) {
    body.innerHTML = notices + `<div class="trips-empty">${icon("compass")}<b>No saved trips yet</b><p>Save the trip you're working on, or import one someone shared. They all collect here, upcoming ones and memories alike.</p></div>`;
    wire(body);
    return;
  }
  const others = remoteSection();
  if (!list.length && !others) { body.innerHTML = notices + `<div class="trips-empty">${icon("search")}<b>Nothing matches</b><p>Try another word, or show all trips.</p></div>`; wire(body); return; }
  body.innerHTML = notices + (!list.length ? "" : view === "table" ? tableHtml(list)
    : groupTrips(list, sort, today()).map((g) => `${g.label ? `<h3 class="trips-group">${esc(g.label)}<span>${g.cards.length}</span></h3>` : ""}
        <div class="trips-grid">${g.cards.map(cardHtml).join("")}</div>`).join("")) + others;
  wire(body);
  if (view === "grid") showTripMaps(body, list);
}

function wire(body: HTMLElement) {
  for (const el of $$<HTMLElement>("[data-name]", body)) {
    const name = el.dataset.name!;
    el.onclick = (e) => { if (!(e.target as HTMLElement).closest("button")) openTrip(name); };
    el.onkeydown = (e) => { if (e.key === "Enter" && e.target === el) openTrip(name); };
    el.querySelector<HTMLButtonElement>("[data-rename]")!.onclick = () => rename(name);
    el.querySelector<HTMLButtonElement>("[data-delete]")!.onclick = () => remove(name);
    el.querySelector<HTMLButtonElement>("[data-sync]")?.addEventListener("click", () => openSyncPanel(name, () => load()));
    $$<HTMLButtonElement>("[data-keep]", el).forEach((b) => { b.onclick = () => decide(name, b.dataset.folder!, b.dataset.keep as "mine" | "theirs"); });
  }
  for (const el of $$<HTMLElement>("[data-remote]", body)) {
    const go = () => openRemote(el.dataset.folder!, el.dataset.remote!);
    el.onclick = go;
    el.onkeydown = (e) => { if (e.key === "Enter" && e.target === el) go(); };
  }
  body.querySelector<HTMLButtonElement>("[data-dismiss]")?.addEventListener("click", async () => { setSyncStatus(await api<SyncStatus>("/api/sync/notices", { method: "POST" }).catch(() => syncStatus)); render(); });
  $$<HTMLButtonElement>("[data-sort]", body).forEach((b) => {
    b.onclick = () => { const s = b.dataset.sort as Sort; sort = s === "date-desc" && sort === "date-desc" ? "date-asc" : s; render(); };
  });
}

/** A clash: which version to keep (the other is kept as a version of the trip, so it can be got back). */
async function decide(name: string, folder: string, keep: "mine" | "theirs") {
  const msg = keep === "mine" ? `Keep this computer's version of "${name}" and send it to ${folderLabel(folder)}? Drive's version is kept as an earlier version (Recover…).`
    : `Take the version from ${folderLabel(folder)} for "${name}"? This computer's version is kept as an earlier version (Recover…).`;
  if (!confirm(msg)) return;
  try {
    setSyncStatus(await api<SyncStatus>("/api/sync/resolve", { method: "POST", body: JSON.stringify({ name, folder, keep }) }));
    // The trip on screen shows Drive's version.
    if (keep === "theirs" && state.saveName === name) await actions.open(name);
    await load();
    toast(keep === "mine" ? "Kept this computer's version" : "Took Drive's version");
  } catch (e) { toast((e as Error).message); }
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

async function rename(from: string) {
  const to = prompt(`New name for "${from}":`, from)?.trim();
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
  if (!confirm(`Delete the saved trip "${name}"? This can't be undone.`)) return;
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
