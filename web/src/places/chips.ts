// The saved places as chips: click to cycle must-see → skip → neutral; 👥 sets how many travelers want a must-see.
import { $, $$, esc, toast } from "../core/dom";
import type { MustSeeHow } from "../../../shared/types";
import { type Mark, groupSize, keepPlace, save, session, setListPlaces, state, whoFor } from "../core/state";
import { placeLoc } from "../geo/locate";
import { drawMap } from "../map/draw";
import { placeMarkers } from "../map/map";
import { mustSeeRoute } from "./route";
import { icon } from "../core/icons";

export function renderChips() {
  const q = $<HTMLInputElement>("#placeFilter").value.toLowerCase();
  const n = groupSize();
  const inList = new Set(session.listPlaces.map((p) => p.title));
  $("#chips").innerHTML = session.places
    .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.note || "").toLowerCase().includes(q))
    .map((p) => {
      const mark = state.marks[p.title] || "", w = whoFor(p.title);
      const badge = mark === "must" && n > 1
        ? `<span class="who ${w < n ? "part" : ""}" data-who="${esc(p.title)}" title="How many of you want to go (click to change)">${icon("users")} ${w}/${n}</span>` : "";
      const how = mark === "must" ? howBadge(p.title) : "";
      // Places outside the selected list (picked on the map, added by the route planner, or must-sees kept from another
      // list) can be removed outright; places in the list are unmarked by clicking.
      const x = p.custom || !inList.has(p.title) ? `<button class="chip-x" type="button" data-remove="${esc(p.title)}" title="Remove this place">${icon("x")}</button>` : "";
      return `<span class="chip ${mark}" data-t="${esc(p.title)}" title="${esc(p.note || p.address)}">${mark === "must" ? icon("star", "star") : ""}${esc(p.title)}${badge}${how}${x}</span>`;
    })
    .join("");
  const mustTitles = Object.keys(state.marks).filter((t) => state.marks[t] === "must");
  const partial = mustTitles.filter((t) => whoFor(t) < n).length;
  const skip = Object.values(state.marks).filter((v) => v === "skip").length;
  const located = session.places.filter(placeLoc).length;
  $("#counts").textContent = session.places.length
    ? `${session.places.length} places (${located} on the map) · ${mustTitles.length} must-see${partial ? ` (${partial} for part of the group)` : ""} · ${skip} skipped`
    : "No places yet. Import a Google Maps list or a CSV, or let Claude pick everything.";
}

const HOW_LABEL: Record<string, string> = { "": "auto", way: `${icon("route")} on the way`, stay: `${icon("hotel")} from stay` };

/** On a must-see: plan it as a stop between stays, from a stay, or let the route decide (click to cycle). */
function howBadge(title: string) {
  const how = state.how?.[title] || "", r = mustSeeRoute(title);
  const where = r?.leg ? `${r.leg.from} → ${r.leg.to}, about +${r.leg.detourKm} km` : "";
  const auto = !r ? "Auto: where it is isn't known yet."
    : r.onWay ? `Auto: it lies on the way (${where}), so it becomes a stop on that travel day.`
    : `Auto: visited from ${r.base ? `${r.base.city} (${r.base.km} km away)` : "a stay"}; ${r.base && r.base.km < 20 ? "it's right by that stay" : `it isn't on the way between stays${where ? ` (closest: ${where})` : ""}`}.`;
  const tip = { "": auto, way: `On the way: a stop on the drive ${where ? `(${where})` : "between two stays"}.`, stay: `From a stay: visited from ${r?.base?.city || "where you sleep"}, as a day trip if it's far.` }[how];
  const label = how ? HOW_LABEL[how] : r?.onWay ? `auto · ${icon("route")}` : "auto";
  return `<span class="how ${how ? "set" : ""}" data-how="${esc(title)}" title="${esc(`${tip} Click to change: auto → on the way → from stay.`)}">${label}</span>`;
}

const NEXT_HOW: Record<string, MustSeeHow | undefined> = { "": "way", way: "stay", stay: undefined };

/** Sets (or clears, with no mark) a place's mark and shows the change. */
export function setMark(title: string, mark: Mark | undefined) {
  if (mark) state.marks[title] = mark; else delete state.marks[title];
  // A must-see from a list is kept with the trip; unmarked, the copy goes (and with it the chip, if it's from another list).
  const place = session.places.find((p) => p.title === title);
  if (mark === "must" && place) keepPlace(place);
  else state.kept = (state.kept || []).filter((k) => k.title !== title);
  setListPlaces(session.listPlaces);
  save(); renderChips(); drawMap();
}

/** Scrolls to a place's chip and flashes it. */
export function flashChip(title: string) {
  const chip = $$(".chip").find((c) => c.dataset.t === title);
  if (chip) { chip.scrollIntoView({ block: "nearest" }); chip.classList.add("flash"); }
}

const NEXT_MARK: Record<string, Mark | undefined> = { "": "must", must: "skip", skip: undefined };

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
  $("#chips").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const rm = target.closest<HTMLElement>("[data-remove]")?.dataset.remove;
    if (rm != null) { removePlace(rm); return; }
    const h = target.dataset.how;
    if (h != null) {
      const next = NEXT_HOW[state.how?.[h] || ""];
      state.how = { ...state.how };
      if (next) state.how[h] = next; else delete state.how[h];
      save(); renderChips(); return;
    }
    const w = target.dataset.who;
    if (w != null) {
      // Cycle all → all-1 → … → 1 → all.
      const next = whoFor(w) - 1;
      if (next >= 1) state.who[w] = next; else delete state.who[w];
      save(); renderChips(); return;
    }
    const t = target.closest<HTMLElement>(".chip")?.dataset.t; if (t == null) return;
    setMark(t, NEXT_MARK[state.marks[t] || ""]);
  });
  // Hovering a place shows its name on the map (one at a time; closed again when the pointer moves on).
  let shown: string | undefined;
  const show = (t: string | undefined) => {
    if (t === shown) return;
    if (shown != null) placeMarkers.get(shown)?.closeTooltip();
    shown = t;
    if (t != null) placeMarkers.get(t)?.openTooltip();
  };
  $("#chips").addEventListener("mouseover", (e) => show((e.target as HTMLElement).closest<HTMLElement>(".chip")?.dataset.t));
  $("#chips").addEventListener("mouseleave", () => show(undefined));
  $("#placeFilter").addEventListener("input", renderChips);
}
