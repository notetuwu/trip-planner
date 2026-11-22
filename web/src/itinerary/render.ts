// Renders the itinerary column and wires up its buttons.
import { $, $$, downloadFile, esc } from "../core/dom";
import { save, session, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { downloadForPhone, shareForPhone } from "../export/offline";
import { runGeneration } from "../generate/run";
import { renderDayChips, selectDay } from "../map/days";
import { drawMap } from "../map/draw";
import { removeStop } from "../map/edit";
import { updateLegInfo } from "../map/legs";
import { renderTripTitle } from "../trip/title";
import { itineraryIcs } from "../export/ics";
import { wireBookAhead } from "./book-ahead";
import { wirePacking } from "./packing";
import { daysHtml, extrasHtml } from "./days-html";
import { checkOpeningHours } from "./hours";
import { searchHtml, wireSearch } from "./search";
import { summaryHtml } from "./summary";
import type { Itinerary } from "../../../shared/types";
import { icon } from "../core/icons";
import { checksSettled, planProblems } from "../generate/autofix";
import { setMapStatus } from "../map/status";

function clearItinerary() {
  state.itinerary = null; state.meta = null; session.selectedDay = null;
  save(); renderItinerary(); renderTripTitle(); drawMap({ fit: true });
}

function redoDay(day: number) {
  const it = state.itinerary, d = it?.days[day];
  if (!it || !d) return;
  const request = prompt(`Re-plan ${d.date} (${d.city}). Anything to change? Leave empty for a fresh take.`, "");
  if (request !== null) runGeneration({ redoDay: { itinerary: it, day, request: request.trim() } });
}

function downloadCalendar() {
  const it = state.itinerary; if (!it) return;
  const byTitle = byTitleMap();
  const ics = itineraryIcs(it, {
    loc: (x, d) => { const l = itemLoc(x, d, byTitle); return l && !l.approx ? l : null; },
    mapsUrl: (x, d) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${x.place}, ${d.city}`)}`,
  });
  const name = (it.destination || "trip").replace(/[^\p{L}\p{N}-]+/gu, "-");
  downloadFile(new Blob([ics], { type: "text/calendar" }), `${name}-itinerary.ics`);
}

function wire(out: HTMLElement) {
  const tools: Record<string, () => void> = {
    phone: downloadForPhone,
    share: shareForPhone,
    ics: downloadCalendar,
    print: () => window.print(),
    json: () => downloadFile(new Blob([JSON.stringify(state.itinerary, null, 2)], { type: "application/json" }), "itinerary.json"),
    clear: () => { if (confirm("Clear this itinerary?")) clearItinerary(); },
  };
  for (const b of $$("[data-tool]", out)) b.onclick = tools[b.dataset.tool!];
  out.querySelector('[data-stale="clear"]')?.addEventListener("click", clearItinerary);
  out.querySelector('[data-stale="gen"]')?.addEventListener("click", () => runGeneration());
  $("#refineBtn").onclick = () => {
    const request = $<HTMLTextAreaElement>("#refineText").value.trim();
    if (request && state.itinerary) runGeneration({ revise: { itinerary: state.itinerary, request } });
  };
  for (const el of $$("[data-redo]", out)) el.onclick = (e) => { e.stopPropagation(); redoDay(+el.dataset.redo!); };
  wireBookAhead(out);
  wirePacking(out, () => renderItinerary());
  // Collapsible sections stay open or closed across redraws.
  for (const el of $$<HTMLDetailsElement>("details[data-fold]", out)) {
    el.open = !!session.folds[el.dataset.fold!];
    el.ontoggle = () => { session.folds[el.dataset.fold!] = el.open; };
  }
  for (const el of $$("[data-sel]", out)) el.onclick = (e) => { if (!(e.target as HTMLElement).closest("a")) selectDay(+el.dataset.sel!); };
  for (const el of $$("[data-bar]", out)) el.onclick = () => selectDay(+el.dataset.bar!, { scroll: true });
  for (const el of $$("[data-del]", out)) el.onclick = () => { const [d, x] = el.dataset.del!.split("-"); removeStop(+d, +x); };
}

export function renderItinerary(error?: string) {
  const it = state.itinerary, meta = state.meta || {};
  const out = $("#output");
  // A plan is being generated there: redraws meanwhile (weather arriving, countries found) would wipe the progress view.
  if (out.dataset.generating) return;
  const errorHtml = error ? `<div class="error">${esc(error)}</div>` : "";
  if (!it) {
    out.innerHTML = errorHtml + `<div class="empty"><div class="sun"></div>Add your stays, pick a place list, and generate.<br>Your itinerary will appear here.</div>`;
    renderDayChips();
    return;
  }
  const cur = meta.currency || state.currency;
  const budget = meta.budget || state.dailyBudget;
  const byTitle = byTitleMap();
  out.innerHTML = errorHtml + summaryHtml(it, byTitle, cur, budget) + `<div class="fix-bar" id="fixBar" hidden></div>` + searchHtml() + daysHtml(it, byTitle, cur, budget) + extrasHtml(it);
  wire(out);
  wireSearch();
  updateLegInfo();
  checkOpeningHours();
  offerFix(it);
  placeInline();
}

/** A re-plan or fix in progress shown inside the itinerary (in its day, or where the fix bar is), kept there when the
 *  itinerary is redrawn meanwhile. */
let inline: { day?: number; fix?: boolean; el: HTMLElement } | null = null;
export function setInlineProgress(p: typeof inline) { inline = p; placeInline(); }

function placeInline() {
  if (!inline) return;
  if (inline.fix) {
    const bar = document.getElementById("fixBar");
    if (bar && bar.firstElementChild !== inline.el) { bar.hidden = false; bar.className = "fix-bar busy"; bar.replaceChildren(inline.el); }
    return;
  }
  const day = document.getElementById(`day-${inline.day}`);
  if (!day || day.contains(inline.el)) return;
  for (const el of day.querySelectorAll<HTMLElement>(":scope > .items, :scope > .day-notes")) el.hidden = true;
  day.append(inline.el);
  day.classList.add("replanning");
}

let offerFor: Itinerary | null = null;
/** Once the map and opening-hours checks are done, offers to send what they found back to the model (any plan, also
 *  older ones made before plans were fixed automatically). */
async function offerFix(it: Itinerary) {
  if (offerFor === it) { showFixBar(it); return; }
  offerFor = it;
  const settled = await checksSettled(it, 120_000);
  setMapStatus("");
  if (!settled || state.itinerary !== it) return;
  showFixBar(it);
}

function showFixBar(it: Itinerary) {
  const bar = document.getElementById("fixBar");
  if (!bar || state.itinerary !== it || inline?.fix) return;
  const problems = planProblems(it);
  bar.hidden = !problems.length;
  if (!problems.length) return;
  const n = problems.length, days = new Set(problems.map((p) => p.day)).size;
  bar.innerHTML = `${icon("warn")}<span>${n} stop${n > 1 ? "s are" : " is"} closed at the planned time or in the wrong town (${days} day${days > 1 ? "s" : ""}).</span>
    <button class="btn" data-fix>Fix ${n > 1 ? "them" : "it"}</button>`;
  bar.querySelector<HTMLButtonElement>("[data-fix]")!.onclick = () => runGeneration({ fix: { itinerary: it, problems } });
}
