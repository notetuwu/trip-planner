// Your trips: every saved trip as a card with a sketch of its route, or as a table. Search, coming up / past / no
// dates, sorting (by trip date the past ones are grouped by year: a memory lane), and open, rename and delete. New
// trip, Import and Save are here too.
import type { AppState } from "../core/state";
import type { TripCard } from "../../../shared/types";
import { $, $$, api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { type Filter, type Sort, groupTrips, hueOf, pickTrips, previewSvg, whenLabel, whenOf } from "./trip-cards";
import { clearTripMaps, showTripMaps } from "./trip-maps";

const VIEW_KEY = "trip-planner-trips-view";
let cards: TripCard[] | null = null, loadError = "";
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
      <span class="tc-tools"><button type="button" class="tc-tool" data-rename title="Rename">${icon("pencil")}</button><button type="button" class="tc-tool" data-delete title="Delete">${icon("trash")}</button></span>
    </div>
    <div class="tc-body">
      <h4>${esc(c.name)}</h4>
      ${c.title && c.title !== c.name ? `<div class="tc-title">${esc(c.title)}</div>` : ""}
      <div class="tc-cities">${cityLine(c) || `<span class="hint">No stays yet</span>`}</div>
      <div class="tc-meta">${c.start ? `<span>${icon("calendar")} ${esc(dateRange(c))}</span>` : ""}${c.nights ? `<span>${icon("bed")} ${c.nights} night${c.nights === 1 ? "" : "s"}</span>` : ""}<span>${icon("users")} ${c.travelers}</span></div>
      <div class="tc-foot">${planText(c)}<span class="tc-ccs">${countryPills(c)}</span></div>
    </div>
  </article>`;
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
  if (!cards.length) {
    body.innerHTML = `<div class="trips-empty">${icon("compass")}<b>No saved trips yet</b><p>Save the trip you're working on, or import one someone shared. They all collect here, upcoming ones and memories alike.</p></div>`;
    return;
  }
  if (!list.length) { body.innerHTML = `<div class="trips-empty">${icon("search")}<b>Nothing matches</b><p>Try another word, or show all trips.</p></div>`; return; }
  body.innerHTML = view === "table" ? tableHtml(list)
    : groupTrips(list, sort, today()).map((g) => `${g.label ? `<h3 class="trips-group">${esc(g.label)}<span>${g.cards.length}</span></h3>` : ""}
        <div class="trips-grid">${g.cards.map(cardHtml).join("")}</div>`).join("");
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
  }
  $$<HTMLButtonElement>("[data-sort]", body).forEach((b) => {
    b.onclick = () => { const s = b.dataset.sort as Sort; sort = s === "date-desc" && sort === "date-desc" ? "date-asc" : s; render(); };
  });
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
  try { cards = await api<TripCard[]>("/api/trips"); loadError = ""; }
  catch (e) { loadError = (e as Error).message; }
  if (dialog().open) render();
  return cards;
}

export function openTrips() {
  cards = null; animate = true;
  if (!dialog().open) dialog().showModal();
  render();
  load();
  setTimeout(() => $<HTMLInputElement>("#tripsSearch").focus(), 50);
}

/** Closed: its maps go (and their tiles stop loading). */
const closed = () => clearTripMaps();

export function initTrips(a: Actions) {
  actions = a;
  dialog().addEventListener("close", closed);
  const search = $<HTMLInputElement>("#tripsSearch");
  search.oninput = () => { query = search.value; render(); };
  $$<HTMLButtonElement>("#tripsDialog [data-filter]").forEach((b) => { b.onclick = () => { filter = b.dataset.filter as Filter; animate = true; render(); }; });
  $$<HTMLButtonElement>("#tripsDialog [data-view]").forEach((b) => {
    b.onclick = () => { view = b.dataset.view as "grid" | "table"; localStorage.setItem(VIEW_KEY, view); animate = true; render(); };
  });
  $<HTMLSelectElement>("#tripsSort").onchange = (e) => { sort = (e.target as HTMLSelectElement).value as Sort; animate = true; render(); };
}
