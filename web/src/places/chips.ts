// The saved places in the Places dialog, as a table you can sort (click a column) and filter (search, status, list):
// a star makes a place a must-see; on must-sees, how many of you want to go and how to fit it in (on the way, from a
// stay, or let the route decide); skip keeps a place out of the plan. Also the sidebar's short summary of it all.
import { $, $$, esc, toast } from "../core/dom";
import type { MustSeeHow, Place } from "../../../shared/types";
import { type Mark, groupSize, keepPlace, listSuggest, save, session, setListPlaces, state, tickedLists, whoFor } from "../core/state";
import { distKm, placeLoc, sameName } from "../geo/locate";
import { geo, geoKey } from "../geo/geocode";
import { renderItinerary } from "../itinerary/render";
import { renderStays } from "../trip/stays";
import { drawMap } from "../map/draw";
import { placeMarkers } from "../map/map";
import { mustSeeRoute } from "./route";
import { icon } from "../core/icons";

type Show = "all" | "must" | "rest" | "skip";
type SortKey = "name" | "list" | "status" | "people";
let show: Show = "all", fromList = "", sortKey: SortKey = "status", sortDir = 1;

const STATUS_ORDER: Record<string, number> = { must: 0, "": 1, skip: 2 };
const listOf = (p: Place, inList: Set<string>) => p.custom ? "Picked on the map" : p.from || (inList.has(p.title) ? "" : "Kept from another list");

/** How a must-see is fitted in when left to the route ("Auto"), in a few words, and the full explanation. */
function autoHow(title: string): { label: string; tip: string } {
  const r = mustSeeRoute(title);
  const where = r?.leg ? `${r.leg.from} → ${r.leg.to}, about +${r.leg.detourKm} km` : "";
  if (!r) return { label: "Auto", tip: "Where it is isn't known yet." };
  if (r.onWay) return { label: "Auto: on the way", tip: `It lies on the way (${where}), so it becomes a stop on that travel day.` };
  const base = r.base ? r.base.city.split(",")[0] : "";
  return {
    label: base ? `Auto: from ${base}` : "Auto: from a stay",
    tip: `Visited from ${r.base ? `${r.base.city} (${r.base.km} km away)` : "a stay"}; ${r.base && r.base.km < 20 ? "it's right by that stay" : `it isn't on the way between stays${where ? ` (closest: ${where})` : ""}`}.`,
  };
}

export function renderChips() {
  const q = $<HTMLInputElement>("#placeFilter").value.toLowerCase().trim();
  const n = groupSize();
  const inList = new Set(session.listPlaces.map((p) => p.title));
  const status = (p: Place) => state.marks[p.title] || "";
  const lists = [...new Set(session.places.map((p) => listOf(p, inList)).filter(Boolean))].sort();
  if (fromList && !lists.includes(fromList)) fromList = "";
  const searched = session.places.filter((p) => (!q || [p.title, p.note, p.address, p.from].some((x) => (x || "").toLowerCase().includes(q))) && (!fromList || listOf(p, inList) === fromList));
  const counts = { all: searched.length, must: 0, rest: 0, skip: 0 };
  for (const p of searched) counts[status(p) === "must" ? "must" : status(p) === "skip" ? "skip" : "rest"]++;
  const rows = searched.filter((p) => show === "all" || (show === "must" ? status(p) === "must" : show === "skip" ? status(p) === "skip" : !status(p)));
  const name = (a: Place, b: Place) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  const cmp: Record<SortKey, (a: Place, b: Place) => number> = {
    name,
    list: (a, b) => listOf(a, inList).localeCompare(listOf(b, inList)) || name(a, b),
    status: (a, b) => STATUS_ORDER[status(a)] - STATUS_ORDER[status(b)] || name(a, b),
    people: (a, b) => (status(b) === "must" ? whoFor(b.title) : -1) - (status(a) === "must" ? whoFor(a.title) : -1) || name(a, b),
  };
  rows.sort((a, b) => cmp[sortKey](a, b) * sortDir);

  const row = (p: Place) => {
    const mark = status(p), must = mark === "must", t = esc(p.title);
    const people = !must ? `<span class="pt-none">—</span>` : n < 2 ? `<span class="pt-none">You</span>`
      : `<select class="pt-select${whoFor(p.title) < n ? " part" : ""}" data-who="${t}" title="How many of you want to go (the planner can split the group for it)">${Array.from({ length: n }, (_, k) => n - k)
        .map((v) => `<option value="${v}"${v === whoFor(p.title) ? " selected" : ""}>${v === n ? `All ${n}` : `${v} of ${n}`}</option>`).join("")}</select>`;
    const how = state.how?.[p.title] || "", auto = must ? autoHow(p.title) : null;
    const howCell = !must ? `<span class="pt-none">—</span>`
      : `<select class="pt-select${how ? " set" : ""}" data-how="${t}" title="${esc(auto!.tip)}">
          <option value=""${!how ? " selected" : ""}>${esc(auto!.label)}</option>
          <option value="way"${how === "way" ? " selected" : ""}>On the way</option>
          <option value="stay"${how === "stay" ? " selected" : ""}>From a stay</option></select>`;
    // Places outside the ticked lists (picked on the map, added by the route planner, or must-sees kept from another
    // list) can be removed outright; places in a list are unmarked instead.
    const removable = p.custom || !inList.has(p.title);
    const where = (p.address || "").split(",").slice(0, 2).join(",").trim();
    return `<tr class="place-row ${mark}" data-t="${t}">
      <td class="pt-star"><button type="button" data-star="${t}" aria-pressed="${must}" title="${must ? "Must-see (click to unstar)" : "Make it a must-see"}">${icon("star")}</button></td>
      <td class="pt-name" title="${esc([p.title, p.note].filter(Boolean).join(" · "))}"><span>${esc(p.title)}</span>${where ? `<small>${esc(where)}</small>` : ""}</td>
      <td class="pt-list">${esc(listOf(p, inList))}</td>
      <td class="pt-people">${people}</td>
      <td class="pt-how">${howCell}</td>
      <td class="pt-act"><button type="button" class="pt-btn" data-skip="${t}" title="${mark === "skip" ? "Plan it again" : "Skip: never plan it"}">${mark === "skip" ? "Unskip" : "Skip"}</button>${removable ? `<button type="button" class="pt-btn" data-remove="${t}" title="Remove this place">${icon("trash")}</button>` : ""}</td>
    </tr>`;
  };
  const th = (k: SortKey | "", label: string, cls = "") => k
    ? `<th class="${cls}"><button type="button" data-sort="${k}" class="${sortKey === k ? "on" : ""}">${label}${sortKey === k ? `<span class="arrow">${sortDir > 0 ? "▲" : "▼"}</span>` : ""}</button></th>`
    : `<th class="${cls}">${label}</th>`;
  const seg = (k: Show, label: string, c: number) => `<button type="button" class="seg${show === k ? " on" : ""}" data-show="${k}">${label} <span class="seg-n">${c}</span></button>`;
  $("#placeShow").innerHTML = seg("all", "All", counts.all) + seg("must", "Must-see", counts.must) + seg("rest", "Options", counts.rest) + seg("skip", "Skipped", counts.skip);
  const pick = $<HTMLSelectElement>("#placeList");
  pick.innerHTML = `<option value="">All lists</option>${lists.map((l) => `<option${l === fromList ? " selected" : ""}>${esc(l)}</option>`).join("")}`;
  pick.hidden = lists.length < 2;
  $("#chips").innerHTML = rows.length
    ? `<table class="place-table"><thead><tr>${th("status", icon("star"), "pt-star")}${th("name", "Place")}${th("list", "List")}${th("people", "People")}${th("", "How")}${th("", "")}</tr></thead>
        <tbody>${rows.map(row).join("")}</tbody></table>`
    : `<p class="hint">${session.places.length ? "Nothing matches." : "No places yet. Import a list, add places on the map, or let the planner pick everything."}</p>`;

  const mustTitles = Object.keys(state.marks).filter((t) => state.marks[t] === "must");
  const partial = mustTitles.filter((t) => whoFor(t) < n).length;
  const skip = Object.values(state.marks).filter((v) => v === "skip").length;
  const located = session.places.filter(placeLoc).length;
  $("#counts").textContent = session.places.length
    ? `${session.places.length} places (${located} on the map) · ${mustTitles.length} must-see${partial ? ` (${partial} for part of the group)` : ""} · ${skip} skipped`
    : "";
  renderSummary(mustTitles, skip);
}

/** The sidebar's short version of Places: how many lists and places, and the must-sees (the rest is in the dialog). */
function renderSummary(must: string[], skip: number) {
  const el = document.getElementById("placesSummary");
  if (!el) return;
  const shown = tickedLists(), sug = shown.filter(listSuggest).length, total = session.places.length;
  if (!session.lists.length && !total) {
    el.innerHTML = `<button type="button" class="list-empty" data-open-places>${icon("plus")}<span><b>Add places</b><br><span class="hint">Import a Google Maps list, or add places on the map. Or skip it and let the planner pick.</span></span></button>`;
  } else {
    const facts = [
      shown.length ? `${shown.length} list${shown.length > 1 ? "s" : ""} on the map${sug ? ` (${sug} suggested ${icon("sparkles")})` : ""}` : "No list on the map",
      `${total} place${total === 1 ? "" : "s"}`, skip ? `${skip} skipped` : "",
    ].filter(Boolean).join(" · ");
    const max = 6;
    el.innerHTML = `<div class="ps-facts">${facts}</div>
      ${must.length ? `<div class="ps-must"><span class="ps-label">${icon("star")} Must-see</span>${must.slice(0, max).map((t) => `<span class="ps-chip">${esc(t)}</span>`).join("")}${must.length > max ? `<span class="hint">+${must.length - max} more</span>` : ""}</div>`
        : `<div class="hint">No must-sees yet: star places in Manage places or on the map.</div>`}`;
  }
  el.querySelector<HTMLButtonElement>("[data-open-places]")?.addEventListener("click", () => document.getElementById("openPlaces")?.click());
}

/** Sets (or clears, with no mark) a place's mark and shows the change. */
export function setMark(title: string, mark: Mark | undefined) {
  if (mark) state.marks[title] = mark; else delete state.marks[title];
  // A must-see from a list is kept with the trip; unmarked, the copy goes (and with it the row, if it's from another list).
  const place = session.places.find((p) => p.title === title);
  if (mark === "must" && place) keepPlace(place);
  else state.kept = (state.kept || []).filter((k) => k.title !== title);
  setListPlaces(session.listPlaces);
  save(); renderChips(); drawMap();
}

/** Scrolls to a place's row and flashes it. */
export function flashChip(title: string) {
  const row = $$(".place-row").find((c) => c.dataset.t === title);
  if (row) { row.scrollIntoView({ block: "nearest" }); row.classList.add("flash"); }
}

/** Takes a place off the stays' day trips (by name, or within about 2 km); returns the stays it was taken from. */
function dropDayTrip(title: string): string[] {
  const n = sameName(title), p = session.places.find((x) => x.title === title), at = p && placeLoc(p);
  const from: string[] = [];
  for (const s of state.stays) {
    const keep = (s.dayTrips || []).filter((t) => {
      const g = t.place ? geo[geoKey(t.place)] : null;
      const same = sameName(t.place) === n || (!!at && !!g && distKm(at, g) < 2);
      if (same) from.push(s.city.split(",")[0]);
      return !same;
    });
    if (keep.length !== (s.dayTrips || []).length) s.dayTrips = keep;
  }
  return from;
}

/** On a must-see: plan it as a stop between stays, from a stay, or let the route decide. */
function setHow(title: string, next: MustSeeHow | undefined) {
  state.how = { ...state.how };
  if (next) state.how[title] = next; else delete state.how[title];
  // On the way now: it's no longer a day trip from a stay too (that would draw a second line and plan it twice).
  const from = next === "way" ? dropDayTrip(title) : [];
  save(); renderChips();
  if (from.length) { renderStays(); drawMap(); renderItinerary(); toast(`“${title}” is now a stop on the way, no longer a day trip from ${from.join(", ")}`); }
}

/** Removes a place that isn't in the selected list (picked on the map, added by the route planner, or kept from another list), with Undo. */
function removePlace(title: string) {
  const before = { customPlaces: [...state.customPlaces], kept: [...(state.kept || [])], marks: { ...state.marks }, how: { ...(state.how || {}) }, who: { ...state.who } };
  state.customPlaces = state.customPlaces.filter((p) => p.title !== title);
  state.kept = (state.kept || []).filter((p) => p.title !== title);
  delete state.marks[title]; delete state.who[title];
  if (state.how) delete state.how[title];
  const refresh = () => { setListPlaces(session.listPlaces); save(); renderChips(); drawMap(); };
  refresh();
  toast(`Removed “${title}”`, () => { Object.assign(state, before); refresh(); });
}

export function initChips() {
  const box = $("#chips");
  box.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const sort = target.closest<HTMLElement>("[data-sort]")?.dataset.sort as SortKey | undefined;
    if (sort) { sortDir = sortKey === sort ? -sortDir : 1; sortKey = sort; renderChips(); return; }
    const rm = target.closest<HTMLElement>("[data-remove]")?.dataset.remove;
    if (rm != null) { removePlace(rm); return; }
    const star = target.closest<HTMLElement>("[data-star]")?.dataset.star;
    if (star != null) { setMark(star, state.marks[star] === "must" ? undefined : "must"); return; }
    const sk = target.closest<HTMLElement>("[data-skip]")?.dataset.skip;
    if (sk != null) setMark(sk, state.marks[sk] === "skip" ? undefined : "skip");
  });
  box.addEventListener("change", (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.dataset.who != null) {
      const t = el.dataset.who, v = Number(el.value);
      if (v >= groupSize()) delete state.who[t]; else state.who[t] = v;
      save(); renderChips();
    } else if (el.dataset.how != null) setHow(el.dataset.how, (el.value || undefined) as MustSeeHow | undefined);
  });
  // Hovering a place shows its name on the map (one at a time; closed again when the pointer moves on).
  let shown: string | undefined;
  const showTip = (t: string | undefined) => {
    if (t === shown) return;
    if (shown != null) placeMarkers.get(shown)?.closeTooltip();
    shown = t;
    if (t != null) placeMarkers.get(t)?.openTooltip();
  };
  box.addEventListener("mouseover", (e) => showTip((e.target as HTMLElement).closest<HTMLElement>(".place-row")?.dataset.t));
  box.addEventListener("mouseleave", () => showTip(undefined));
  $("#placeFilter").addEventListener("input", renderChips);
  $("#placeShow").addEventListener("click", (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("[data-show]")?.dataset.show as Show | undefined;
    if (k) { show = k; renderChips(); }
  });
  $<HTMLSelectElement>("#placeList").addEventListener("change", (e) => { fromList = (e.target as HTMLSelectElement).value; renderChips(); });
}
