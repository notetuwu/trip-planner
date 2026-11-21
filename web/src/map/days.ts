// The day chips above the map, selecting a day, and linking itinerary stops with their pins.
import { $, $$, esc } from "../core/dom";
import { dayColor, fmtShort } from "../core/format";
import { session, state } from "../core/state";
import { drawMap } from "./draw";
import { itemMarkers } from "./map";

export function renderDayChips() {
  const it = state.itinerary, sel = session.selectedDay;
  $("#dayChips").innerHTML = !it ? `<span class="hint">Stays and saved places — generate an itinerary to see each day's route.</span>` :
    `<button class="day-chip ${sel == null ? "on" : ""}" data-day="">All days</button>` +
    it.days.map((d, i) => `<button class="day-chip ${sel === i ? "on" : ""}" data-day="${i}" style="--c:${dayColor(i)}" title="${esc(d.title)}"><i></i>${esc(fmtShort(d.date) || `Day ${i + 1}`)}</button>`).join("");
}

/** Shows one day on the map (or all again when it's already selected). */
export function selectDay(i: number | null, { scroll = false } = {}) {
  session.selectedDay = session.selectedDay === i ? null : i;
  for (const el of $$(".day")) el.classList.toggle("selected", +el.dataset.i! === session.selectedDay);
  drawMap({ fit: true });
  if (scroll && session.selectedDay != null) $(`.day[data-i="${session.selectedDay}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  $(".day-chip.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function highlightItem(di: number, xi: number) {
  $(`.item[data-k="${di}-${xi}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function initDays() {
  $("#dayChips").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-day]"); if (!b) return;
    selectDay(b.dataset.day === "" ? null : +b.dataset.day!, { scroll: true });
  });
  // Hovering a stop in the itinerary pops its pin on the map.
  $("#output").addEventListener("mouseover", (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>(".item")?.dataset.k;
    for (const p of $$(".num-pin.hot")) p.classList.remove("hot");
    const m = k ? itemMarkers.get(k) : undefined;
    if (m) { m.getElement()?.querySelector(".num-pin")?.classList.add("hot"); m.openTooltip(); }
  });
}
