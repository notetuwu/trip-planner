// Renders the itinerary column and wires up its buttons.
import { openChat } from "../trip/companion";
import { openCosts } from "./costs";
import { addDays } from "../core/format";
import { $, $$, downloadFile, esc, toast } from "../core/dom";
import { groupBudget, save, session, state } from "../core/state";
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
import { type Section, openSection } from "./sections";
import type { Itinerary } from "../../../shared/types";
import { icon } from "../core/icons";
import { pointUrl, searchUrl } from "../core/maps-links";
import { checksSettled, planProblems, quickFixes } from "../generate/autofix";
import { setMapStatus } from "../map/status";
import { modeName, orderSplitRuns, plannedMode } from "../trip/modes";
import { groupsFromText } from "../../../shared/groups";

/** The stays' "Planner decides" menus say what the current plan picked ("Planner decides (train)"). */
function showPlannedModes() {
  const label = (from: string, to: string) => { const m = plannedMode(from, to); return m ? `Planner decides (${modeName(m)})` : "Planner decides"; };
  for (const sel of $$<HTMLSelectElement>(".stay-leg select[data-k=travel]")) {
    const i = +sel.closest<HTMLElement>(".stay-leg")!.dataset.i!, a = state.stays[i - 1], b = state.stays[i];
    const opt = sel.querySelector<HTMLOptionElement>('option[value=""]');
    if (opt && a && b) opt.textContent = label(a.city, b.city);
  }
  for (const sel of $$<HTMLSelectElement>(".day-trip select[data-dt=mode]")) {
    const s = state.stays[+sel.closest<HTMLElement>(".stay")!.dataset.i!];
    const t = s?.dayTrips?.[+sel.closest<HTMLElement>(".day-trip")!.dataset.ti!];
    const opt = sel.querySelector<HTMLOptionElement>('option[value=""]');
    if (opt && s && t) opt.textContent = label(s.city, t.place);
  }
}

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

/** All days of one stay at once, so they can be rearranged (a booking moved a sight to another day, say). */
function replanStay(si: number) {
  const it = state.itinerary, s = state.stays[si];
  if (!it || !s?.start) return;
  const end = addDays(s.start, Number(s.nights) || 0);
  const days = it.days.map((d, i) => (d.date >= s.start && d.date <= end ? i : -1)).filter((i) => i >= 0);
  if (!days.length) return;
  const asked = prompt(`Re-plan ${s.city} (${days.length} days)? Anything to change? Leave empty to fit it around the bookings and whatever changed.`, "");
  if (asked === null) return;
  const request = `Re-plan these ${days.length} days of the stay in ${s.city} together: you may move sights between them so that everything fits (bookings on their days and times, opening days, the must-sees). Keep the arrival and departure transfers, the day trips and where they sleep.${asked.trim() ? ` They ask: ${asked.trim()}` : ""}`;
  runGeneration({ edit: { itinerary: it, days, request } });
}

function downloadCalendar() {
  const it = state.itinerary; if (!it) return;
  const byTitle = byTitleMap();
  const ics = itineraryIcs(it, {
    loc: (x, d) => { const l = itemLoc(x, d, byTitle); return l && !l.approx ? l : null; },
    mapsUrl: (x, d) => { const l = itemLoc(x, d, byTitle); return l && !l.approx ? pointUrl(l, x.place) : searchUrl(`${x.place}, ${d.city}`, l); },
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
  $("#refineBtn").onclick = () => openChat("");
  for (const el of $$("[data-redo]", out)) el.onclick = (e) => { e.stopPropagation(); redoDay(+el.dataset.redo!); };
  for (const el of $$("[data-replan-stay]", out)) el.onclick = (e) => { e.stopPropagation(); replanStay(+el.dataset.replanStay!); };
  // A stay's heading folds its days away (and back).
  for (const el of $$("[data-fold-stay]", out)) el.onclick = () => {
    const si = +el.dataset.foldStay!, group = el.closest(".stay-group")!;
    if (session.foldedStays.has(si)) session.foldedStays.delete(si); else session.foldedStays.add(si);
    group.classList.toggle("folded", session.foldedStays.has(si));
  };
  wireBookAhead(out);
  wirePacking(out, () => renderItinerary());
  // Collapsible sections stay open or closed across redraws.
  for (const el of $$<HTMLDetailsElement>("details[data-fold]", out)) {
    el.open = !!session.folds[el.dataset.fold!];
    el.ontoggle = () => { session.folds[el.dataset.fold!] = el.open; };
  }
  for (const el of $$("[data-sel]", out)) el.onclick = (e) => { if (!(e.target as HTMLElement).closest("a")) selectDay(+el.dataset.sel!); };
  for (const el of $$("[data-bar]", out)) el.onclick = () => selectDay(+el.dataset.bar!, { scroll: true });
  for (const el of $$("[data-costs]", out)) el.onclick = () => openCosts();
  for (const el of $$("[data-section]", out)) el.onclick = () => openSection(el.dataset.section as Section, () => renderItinerary());
  for (const el of $$("[data-del]", out)) el.onclick = () => { const [d, x] = el.dataset.del!.split("-"); removeStop(+d, +x); };
}

export function renderItinerary(error?: string) {
  const it = state.itinerary, meta = state.meta || {};
  const out = $("#output");
  // A plan is being generated there: redraws meanwhile (weather arriving, countries found) would wipe the progress view.
  if (out.dataset.generating) return;
  showPlannedModes();
  // Splits written only into the text get their groups (plans from before this was read on the server too).
  if (it && (groupsFromText(it.days) || orderSplitRuns(it.days))) { orderSplitRuns(it.days); save(); }
  const errorHtml = error ? `<div class="error">${esc(error)}</div>` : "";
  if (!it) {
    out.innerHTML = errorHtml + `<div class="empty"><div class="sun"></div>Add your stays, pick a place list, and generate.<br>Your itinerary will appear here.</div>`;
    renderDayChips();
    return;
  }
  const cur = meta.currency || state.currency;
  // The group's budget a day: day costs are for everyone.
  const budget = meta.budget || groupBudget();
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
/** After days were re-planned or fixed (the same itinerary, changed): wait for the checks again before counting. */
export function resetFixOffer() { offerFor = null; }
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
  bar.innerHTML = `${icon("warn")}<span>${n} stop${n > 1 ? "s need" : " needs"} fixing on ${days} day${days > 1 ? "s" : ""}: closed at the planned time, in the wrong town, or a restaurant they already eat at.</span>
    <button class="btn" data-fix>Fix ${n > 1 ? "them" : "it"}</button>`;
  bar.querySelector<HTMLButtonElement>("[data-fix]")!.onclick = () => {
    // Stops just before opening time move by themselves; the model gets only what's left.
    if (quickFixes(it)) {
      save(); renderItinerary();
      const left = planProblems(it);
      toast(left.length ? `Moved stops to their opening times; ${left.length} problem${left.length > 1 ? "s" : ""} left for the planner` : "Moved stops to their opening times");
      if (!left.length) return;
      runGeneration({ fix: { itinerary: it, problems: left } });
      return;
    }
    runGeneration({ fix: { itinerary: it, problems: planProblems(it) } });
  };
}
