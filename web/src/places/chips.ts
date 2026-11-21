// The saved places as chips: click to cycle must-see → skip → neutral; 👥 sets how many travelers want a must-see.
import { $, $$, esc } from "../core/dom";
import { type Mark, groupSize, save, session, state, whoFor } from "../core/state";
import { placeLoc } from "../geo/locate";
import { drawMap } from "../map/draw";
import { placeMarkers } from "../map/map";

export function renderChips() {
  const q = $<HTMLInputElement>("#placeFilter").value.toLowerCase();
  const n = groupSize();
  $("#chips").innerHTML = session.places
    .filter((p) => !q || p.title.toLowerCase().includes(q) || (p.note || "").toLowerCase().includes(q))
    .map((p) => {
      const mark = state.marks[p.title] || "", w = whoFor(p.title);
      const badge = mark === "must" && n > 1
        ? `<span class="who ${w < n ? "part" : ""}" data-who="${esc(p.title)}" title="How many of you want to go (click to change)">👥 ${w}/${n}</span>` : "";
      return `<span class="chip ${mark}" data-t="${esc(p.title)}" title="${esc(p.note || p.address)}">${esc(p.title)}${badge}</span>`;
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

/** Sets (or clears, with no mark) a place's mark and shows the change. */
export function setMark(title: string, mark: Mark | undefined) {
  if (mark) state.marks[title] = mark; else delete state.marks[title];
  save(); renderChips(); drawMap();
}

/** Scrolls to a place's chip and flashes it. */
export function flashChip(title: string) {
  const chip = $$(".chip").find((c) => c.dataset.t === title);
  if (chip) { chip.scrollIntoView({ block: "nearest" }); chip.classList.add("flash"); }
}

const NEXT_MARK: Record<string, Mark | undefined> = { "": "must", must: "skip", skip: undefined };

export function initChips() {
  $("#chips").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
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
