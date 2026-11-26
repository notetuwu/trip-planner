// The day chips above the map, selecting a day, and linking itinerary stops with their pins.
import { revealInSplit } from "../itinerary/split-tabs";
import { moveTo } from "./move";
import * as L from "leaflet";
import { legLines, lightLegs } from "./draw-days";
import { stayLines } from "./draw-stays";
import { showPane } from "../core/layout";
import { $, $$, esc, toast } from "../core/dom";
import { dayColor, fmtShort } from "../core/format";
import { session, state } from "../core/state";
import { drawMap } from "./draw";
import { itemMarkers, map } from "./map";

export function renderDayChips() {
  const it = state.itinerary, sel = session.selectedDay;
  $("#dayChips").innerHTML = !it ? `<span class="hint">Stays and saved places — generate an itinerary to see each day's route.</span>` :
    `<button class="day-chip ${sel == null ? "on" : ""}" data-day="">All days</button>` +
    it.days.map((d, i) => `<button class="day-chip ${sel === i ? "on" : ""}" data-day="${i}" style="--c:${dayColor(i)}" title="${esc(d.title)}"><i></i>${esc(fmtShort(d.date) || `Day ${i + 1}`)}</button>`).join("");
}

/** Shows one day on the map (or all again when it's already selected). */
export function selectDay(i: number | null, { scroll = false, fit = true } = {}) {
  session.selectedDay = session.selectedDay === i ? null : i;
  for (const el of $$(".day")) el.classList.toggle("selected", +el.dataset.i! === session.selectedDay);
  drawMap({ fit });
  const group = session.selectedDay != null ? $(`.day[data-i="${session.selectedDay}"]`)?.closest<HTMLElement>(".stay-group") : null;
  if (group?.classList.contains("folded")) { session.foldedStays.delete(+group.dataset.stayGroup!); group.classList.remove("folded"); }
  if (scroll && session.selectedDay != null) $(`.day[data-i="${session.selectedDay}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  $(".day-chip.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Scrolls the itinerary to a stop and flashes it. */
export function highlightItem(di: number, xi: number) {
  showPane("output");
  const el = $(`.item[data-k="${di}-${xi}"]`);
  if (!el) return;
  revealInSplit(el);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.toggle("flash", false); void el.offsetWidth; el.classList.toggle("flash", true);
}

/** Moves the map to a stop and opens its pin (showing its day if another one is selected). */
/** A stop of a ride (clicked in the itinerary): the map goes there, with its name. */
export function goToStop(lat: number, lng: number, name: string) {
  if (!map) return;
  showPane("map");
  session.userMoved = true;
  // (Listened for first: already there, the map says it's done at once.)
  map.once("moveend", () => { if (map) L.popup({ closeButton: false, className: "leg-tip-pop", offset: [0, -4] }).setLatLng([lat, lng]).setContent(esc(name || "Stop")).openOn(map); });
  moveTo(map, [lat, lng], 17);
}

export function showOnMap(di: number, xi: number) {
  if (!map) return;
  showPane("map");
  // An open popup holds back redraws (so the day switch below wouldn't draw this stop's pin).
  map.closePopup();
  // Only the selected day's pins are drawn: switch to this stop's day if another is shown.
  if (session.selectedDay != null && session.selectedDay !== di) selectDay(di, { fit: false });
  const m = itemMarkers.get(`${di}-${xi}`);
  if (!m) { toast("This stop has no spot on the map yet: set where it is with the crosshair button"); return; }
  // Stays where it's put: redraws (lookups and routes arriving) don't fit the map back to the whole trip.
  session.userMoved = true;
  // The map is above or below the plan on narrower screens: bring it into view.
  const box = $("#map").getBoundingClientRect();
  if (box.bottom < 60 || box.top > innerHeight - 60) $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
  map.once("moveend", () => itemMarkers.get(`${di}-${xi}`)?.openPopup());
  moveTo(map, m.getLatLng(), 15);
}

/** The pin whose name is shown because its stop is hovered in the list (only one at a time). */
let shown: L.Marker | undefined;
function showPin(m: L.Marker | undefined) {
  if (m === shown) return;
  shown?.closeTooltip();
  for (const p of $$(".num-pin.hot")) p.classList.toggle("hot", false);
  shown = m;
  if (m) { m.getElement()?.querySelector(".num-pin")?.classList.add("hot"); m.openTooltip(); }
}

export function initDays() {
  // A mouse wheel scrolls the row of days sideways (it only scrolls up and down by itself).
  $("#dayChips").addEventListener("wheel", (e) => {
    const el = e.currentTarget as HTMLElement;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, { passive: false });
  $("#dayChips").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-day]"); if (!b) return;
    selectDay(b.dataset.day === "" ? null : +b.dataset.day!, { scroll: true });
  });
  // Hovering a stop in the itinerary pops its pin on the map, and lights up the whole way there. In a travel day's
  // journey, the way between the two stays lights up too: anywhere on its card, or on a stop with no line of its own.
  let hot = "";
  const light = (keys: string[], stay: number | null) => {
    const now = `${keys}|${stay}`;
    if (now === hot) return;
    hot = now;
    const line = stay == null ? undefined : stayLines.get(stay);
    lightLegs(keys, line ? [line] : []);
  };
  $("#output").addEventListener("mouseover", (e) => {
    const at = e.target as HTMLElement, k = at.closest<HTMLElement>(".item")?.dataset.k;
    showPin(k ? itemMarkers.get(k) : undefined);
    const card = at.closest<HTMLElement>("[data-stay-leg]"), stay = card ? +card.dataset.stayLeg! : null;
    if (k) return light([k], legLines.has(k) ? null : stay);
    light(card ? [...card.querySelectorAll<HTMLElement>(".item")].map((el) => el.dataset.k!) : [], stay);
  });
  $("#output").addEventListener("mouseleave", () => { showPin(undefined); light([], null); });
  // The same for the way between two stays in the trip's setup.
  $("#stays").addEventListener("mouseover", (e) => {
    const leg = (e.target as HTMLElement).closest<HTMLElement>(".stay-leg");
    light([], leg ? +leg.dataset.i! : null);
  });
  $("#stays").addEventListener("mouseleave", () => light([], null));
}
