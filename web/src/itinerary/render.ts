// Renders the itinerary column and wires up its buttons.
import { initSplitTabs } from "./split-tabs";
import { openAddStop, startEmptyPlan } from "./manual";
import { openChat } from "../trip/companion";
import { type CostsTab, openCosts } from "./costs";
import { openPhotosView } from "./photos-view";
import { openPreview } from "./preview-view";
import { addDays, fmtDate } from "../core/format";
import { $, $$, downloadFile, esc, toast } from "../core/dom";
import { groupBudget, save, session, state } from "../core/state";
import { byTitleMap, itemLoc, stopMapsUrl } from "../geo/item-loc";
import { canShareFiles, downloadForPhone, shareForPhone } from "../export/offline";
import { openIphoneGuide } from "../export/iphone";
import { toggleMenu } from "../core/menu";
import { displayCurrency, fxReady, loadFx, pickDisplayCurrency } from "./costs-data";
import { runGeneration } from "../generate/run";
import { renderDayChips, selectDay, showOnMap } from "../map/days";
import { drawMap } from "../map/draw";
import { removeStop } from "../map/edit";
import { openPin } from "./pin";
import { openStopEdit } from "./stop-edit";
import { wireMoves } from "./move-stops";
import { updateLegInfo } from "../map/legs";
import { renderTripTitle } from "../trip/title";
import { itineraryIcs } from "../export/ics";
import { downloadMapFile } from "../export/map-file";
import { wireBookAhead } from "./book-ahead";
import { wirePacking } from "./packing";
import { daysHtml, extrasHtml } from "./days-html";
import { useSuggestedJourney } from "./journey";
import { checkOpeningHours } from "./hours";
import { searchHtml, wireSearch } from "./search";
import { openReview, refreshReview } from "./review";
import { cleanStop } from "./duplicates";
import { onQueueChange, queuedJobs } from "../generate/queue";
import { summaryHtml } from "./summary";
import { type Section, openSection } from "./sections";
import { actualDaysHtml, actualSwitchHtml, hasActual, openJournal, setJournalRedraw } from "./journal";
import type { Itinerary } from "../../../shared/types";
import { icon } from "../core/icons";
import { type Problem, type Stop, checksSettled, planDuplicates, planProblems, quickFixes, setRepeatOk } from "../generate/autofix";
import { setMapStatus } from "../map/status";
import { modeName, orderSplitRuns, plannedMode } from "../trip/modes";
import { groupsFromText } from "../../../shared/groups";
import { askConfirm, askText } from "../core/ask";

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

async function redoDay(day: number) {
  const it = state.itinerary, d = it?.days[day];
  if (!it || !d) return;
  const request = await askText({ title: `Re-plan day ${day + 1}`, text: `${d.date} · ${d.city}. Anything to change? Leave it empty for a fresh take.`, placeholder: "e.g. more relaxed, a vegan lunch, the castle in the morning", multiline: true, ok: "Re-plan" });
  if (request !== null) runGeneration({ redoDay: { itinerary: it, day, request: request.trim() } });
}

/** All days of one stay at once, so they can be rearranged (a booking moved a sight to another day, say). */
async function replanStay(si: number) {
  const it = state.itinerary, s = state.stays[si];
  if (!it || !s?.start) return;
  const end = addDays(s.start, Number(s.nights) || 0);
  const days = it.days.map((d, i) => (d.date >= s.start && d.date <= end ? i : -1)).filter((i) => i >= 0);
  if (!days.length) return;
  const asked = await askText({ title: `Re-plan ${s.city}`, text: `All ${days.length} days together. Anything to change? Leave it empty to fit them around the bookings and whatever changed.`, multiline: true, ok: "Re-plan" });
  if (asked === null) return;
  const request = `Re-plan these ${days.length} days of the stay in ${s.city} together: you may move sights between them so that everything fits (bookings on their days and times, opening days, the must-sees). Keep the arrival and departure transfers, the day trips and where they sleep.${asked.trim() ? ` They ask: ${asked.trim()}` : ""}`;
  runGeneration({ edit: { itinerary: it, days, request } });
}

function downloadCalendar() {
  const it = state.itinerary; if (!it) return;
  const byTitle = byTitleMap();
  const ics = itineraryIcs(it, {
    loc: (x, d) => { const l = itemLoc(x, d, byTitle); return l && !l.approx ? l : null; },
    mapsUrl: (x, d) => stopMapsUrl(x, d, itemLoc(x, d, byTitle)),
  });
  const name = (it.destination || "trip").replace(/[^\p{L}\p{N}-]+/gu, "-");
  downloadFile(new Blob([ics], { type: "text/calendar" }), `${name}-itinerary.ics`);
}

function wire(out: HTMLElement) {
  const tools: Record<string, () => void> = {
    phone: downloadForPhone,
    share: shareForPhone,
    ics: downloadCalendar,
    kml: () => downloadMapFile("kml"),
    gpx: () => downloadMapFile("gpx"),
    print: () => window.print(),
    json: () => downloadFile(new Blob([JSON.stringify(state.itinerary, null, 2)], { type: "application/json" }), "itinerary.json"),
    clear: async () => { if (await askConfirm({ title: "Clear this itinerary?", text: "The day-by-day plan goes; the stays and places stay. (The saved trip keeps earlier versions: Your trips → Recover.)", ok: "Clear", danger: true })) clearItinerary(); },
  };
  for (const b of $$("[data-tool]", out)) b.onclick = tools[b.dataset.tool!];
  // Show prices in: another currency for the figures shown (the amounts stay in the trip's).
  const showCur = out.querySelector<HTMLButtonElement>("[data-show-cur]");
  if (showCur) showCur.onclick = () => pickDisplayCurrency(showCur, () => renderItinerary());
  // Export: every way the plan leaves the planner, in one menu.
  const exportBtn = out.querySelector<HTMLButtonElement>("[data-export]");
  if (exportBtn) exportBtn.onclick = () => toggleMenu(exportBtn, [
    { id: "phone", icon: "phone", label: "For phone", hint: "One file that works offline: today's stops, the plan, expenses and the journal", run: tools.phone },
    { id: "iphone", icon: "phone", label: "For iPhone", hint: "An iPhone can't run that file by itself: how to open it there, in three steps", run: openIphoneGuide },
    ...(canShareFiles() ? [{ id: "share", icon: "share" as const, label: "Share", hint: "The phone file through the system share menu", run: tools.share }] : []),
    { id: "ics", icon: "calendar", label: "Calendar", hint: "Every stop as an event, for your phone's calendar", run: tools.ics },
    { id: "kml", icon: "map", label: "Map file · KML", hint: "For Google My Maps, Google Earth and Organic Maps", run: tools.kml },
    { id: "gpx", icon: "route", label: "Map file · GPX", hint: "For Garmin, OsmAnd, Komoot and Organic Maps", run: tools.gpx },
    { id: "print", icon: "printer", label: "Print / PDF", hint: "A clean printout with a cover page", run: tools.print },
    { id: "json", icon: "download", label: "JSON", hint: "The itinerary as data", run: tools.json },
  ]);
  out.querySelector('[data-stale="clear"]')?.addEventListener("click", clearItinerary);
  out.querySelector('[data-stale="gen"]')?.addEventListener("click", () => runGeneration());
  $("#refineBtn").onclick = () => openChat("");
  for (const el of $$<HTMLElement>("[data-add-open]", out)) el.onclick = () => openAddStop(out, +el.dataset.addOpen!);
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
  for (const el of $$("[data-costs]", out)) el.onclick = () => openCosts((el.dataset.costs || undefined) as CostsTab | undefined);
  for (const el of $$("[data-photos]", out)) el.onclick = () => openPhotosView();
  for (const el of $$("[data-preview]", out)) el.onclick = () => openPreview();
  for (const el of $$("[data-journal]", out)) el.onclick = () => openJournal();
  for (const el of $$("[data-actual]", out)) el.onclick = () => { session.showActual = el.dataset.actual === "1"; renderItinerary(); };
  for (const el of $$("[data-section]", out)) el.onclick = () => openSection(el.dataset.section as Section, () => renderItinerary());
  for (const el of $$("[data-del]", out)) el.onclick = () => { const [d, x] = el.dataset.del!.split("-"); removeStop(+d, +x); };
  wireMoves(out);
  // A suggested journey between two stays, written into the travel day as its stops (Undo takes them out again).
  for (const el of $$<HTMLButtonElement>("[data-journey-use]", out)) el.onclick = () => {
    const di = +el.dataset.journeyUse!, day = state.itinerary!.days[di], before = [...day.items];
    if (!useSuggestedJourney(di)) return;
    save(); renderItinerary(); drawMap();
    toast("Added the journey to the day", () => { day.items = before; save(); renderItinerary(); drawMap(); });
  };
  for (const el of $$<HTMLElement>("[data-pin]", out)) el.onclick = () => { const [d, x] = el.dataset.pin!.split("-"); openPin(+d, +x, el); };
  for (const el of $$<HTMLElement>("[data-show]", out)) el.onclick = () => { const [d, x] = el.dataset.show!.split("-"); showOnMap(+d, +x); };
  for (const el of $$<HTMLElement>("[data-leg-edit]", out)) el.onclick = () => { const [d, x] = el.dataset.legEdit!.split("-"); openStopEdit(+d, +x, "leg"); };
  // The stop's edit window: everything about it at once.
  // (Its own attribute: "data-edit" is where the who-changed-it marks go, see saves/collab.ts.)
  for (const el of $$<HTMLElement>("[data-stop-edit]", out)) el.onclick = () => { const [d, x] = el.dataset.stopEdit!.split("-"); openStopEdit(+d, +x); };
}

export function renderItinerary(error?: string) {
  const it = state.itinerary, meta = state.meta || {};
  const out = $("#output");
  // A plan is being generated there: redraws meanwhile (weather arriving, countries found) would wipe the progress view.
  if (out.dataset.generating) return;
  // Prices shown in another currency: drawn again once the rates are in.
  if (displayCurrency() !== state.currency && !fxReady) loadFx().then((got) => { if (got) renderItinerary(); });
  showPlannedModes();
  // Splits written only into the text get their groups (plans from before this was read on the server too).
  if (it && (groupsFromText(it.days) || orderSplitRuns(it.days))) { orderSplitRuns(it.days); save(); }
  const errorHtml = error ? `<div class="error">${esc(error)}</div>` : "";
  if (!it) {
    out.innerHTML = errorHtml + `<div class="empty"><div class="sun"></div>Add your stays, pick a place list, and generate.<br>Your itinerary will appear here.
      <div class="empty-acts"><span class="hint">Or plan it yourself:</span><button type="button" class="btn" data-empty-plan>${icon("list")} Start an empty plan</button></div></div>`;
    out.querySelector<HTMLButtonElement>("[data-empty-plan]")!.onclick = () => startEmptyPlan();
    renderDayChips();
    return;
  }
  const cur = meta.currency || state.currency;
  // The group's budget a day: day costs are for everyone.
  const budget = meta.budget || groupBudget();
  const byTitle = byTitleMap();
  const unfixed = meta.unfixed ? `<div class="fix-bar"><span class="fix-msg">${icon("warn")}<span>${esc(meta.unfixed)}</span></span></div>` : "";
  out.innerHTML = errorHtml + summaryHtml(it, byTitle, cur, budget) + unfixed + `<div class="fix-bar" id="fixBar" hidden></div>` + actualSwitchHtml() + (session.showActual && hasActual() ? actualDaysHtml(cur) : searchHtml() + daysHtml(it, byTitle, cur, budget)) + extrasHtml(it);
  wire(out);
  initSplitTabs(out);
  showDuplicates(it);
  wireSearch();
  updateLegInfo();
  checkOpeningHours();
  offerFix(it);
  placeInline();
  markQueued();
  refreshReview();
}

/** A re-plan or fix in progress shown inside the itinerary (in its day, or where the fix bar is), kept there when the
 *  itinerary is redrawn meanwhile. */
let inline: { day?: number; days?: number[]; fix?: boolean; el: HTMLElement } | null = null;
export function setInlineProgress(p: typeof inline) { inline = p; placeInline(); }

function placeInline() {
  if (!inline) return;
  if (inline.fix) {
    const bar = document.getElementById("fixBar");
    if (bar && bar.firstElementChild !== inline.el) { bar.hidden = false; bar.className = "fix-bar busy"; bar.replaceChildren(inline.el); }
    return;
  }
  // Several days (a stay re-planned, or days the chat changes): the progress in the first, and in each of the others a
  // line saying it's being changed with it. All in the days themselves rather than up in the fix bar, out of sight.
  const [first, ...rest] = inline.days || [inline.day!];
  const day = document.getElementById(`day-${first}`);
  if (!day || day.contains(inline.el)) return;
  const firstDate = state.itinerary?.days[first]?.date || "";
  for (const i of [first, ...rest]) {
    const d = document.getElementById(`day-${i}`);
    if (!d) continue;
    const group = d.closest<HTMLElement>(".stay-group");
    if (group?.classList.contains("folded")) {
      session.foldedStays.delete(+group.dataset.stayGroup!);
      group.classList.remove("folded");
    }
    for (const el of d.querySelectorAll<HTMLElement>(":scope > .items, :scope > .day-notes")) el.hidden = true;
    d.classList.add("replanning");
    if (i !== first && !d.querySelector(".inline-wait")) {
      d.insertAdjacentHTML("beforeend", `<div class="inline-progress inline-wait"><span class="wait-dot"></span>Being changed together with
        <a href="#day-${first}" data-goto-day="${first}">${esc(firstDate ? fmtDate(firstDate) : `day ${first + 1}`)}</a>; the progress is there.</div>`);
      d.querySelector<HTMLAnchorElement>("[data-goto-day]")!.onclick = (e) => { e.preventDefault(); day.scrollIntoView({ block: "start", behavior: "smooth" }); };
    }
  }
  day.append(inline.el);
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

/** Days lined up to be redone (from the problem review) say so, until their turn comes and the progress shows instead. */
let queueWatched = false;
function markQueued() {
  if (!queueWatched) { queueWatched = true; onQueueChange(markQueued); }
  for (const el of $$(".rv-queued")) el.remove();
  for (const job of queuedJobs()) {
    if (job.status !== "queued") continue;
    for (const d of job.days) document.getElementById(`day-${d}`)?.insertAdjacentHTML("beforeend",
      `<div class="inline-progress inline-wait rv-queued"><span class="wait-dot"></span>Lined up to be redone${job.days.length > 1 ? ` together with ${esc(job.days.filter((x) => x !== d).map((x) => `day ${x + 1}`).join(", "))}` : ""}, after the change being made now.</div>`);
  }
}

const dayLabel = (it: Itinerary, i: number) => `Day ${i + 1}${it.days[i]?.date ? ` · ${fmtDate(it.days[i].date) || it.days[i].date}` : ""}`;

/** Under each stop that's on another day too: where else (opens the review on it), and buttons to keep the repeat or
 *  remove this copy. Needs no lookups, so it shows as soon as the plan does. */
function showDuplicates(it: Itinerary) {
  const others = new Map<string, { stops: Stop[]; key: string }>();
  for (const { first, again, key } of planDuplicates(it)) {
    others.set(`${first}`, { stops: [...(others.get(`${first}`)?.stops || []), again], key });
    others.set(`${again}`, { stops: [...(others.get(`${again}`)?.stops || []), first], key });
  }
  for (const el of $$<HTMLElement>("[data-dup]")) {
    const at = el.dataset.dup!.split("-").map(Number) as Stop, also = others.get(`${at}`);
    el.hidden = !also;
    if (!also) continue;
    const days = [...new Set(also.stops.map((s) => s[0]))];
    el.innerHTML = `${icon("warn")}<span>Also on ${days.map((d) => `<a href="#day-${d}" data-dup-goto title="Compare the days">${esc(dayLabel(it, d))}</a>`).join(", ")}</span>
      <button class="link-btn" data-dup-ok title="It's meant to be on both days: stop flagging it">Fine as is</button>
      <button class="link-btn" data-dup-remove title="Remove this stop; the other day keeps it">Remove</button>`;
    for (const a of el.querySelectorAll<HTMLAnchorElement>("[data-dup-goto]")) a.onclick = (e) => { e.preventDefault(); openReview(at); };
    el.querySelector<HTMLButtonElement>("[data-dup-remove]")!.onclick = () => removeStop(at[0], at[1]);
    el.querySelector<HTMLButtonElement>("[data-dup-ok]")!.onclick = () => {
      const name = cleanStop(it.days[at[0]].items[at[1]].place);
      setRepeatOk(also.key, name, true);
      save(); renderItinerary();
      toast(`"${name}" may repeat`, () => { setRepeatOk(also.key, name, false); save(); renderItinerary(); });
    };
  }
}

/** The banner above the days once the checks are done: how many problems of each kind, Review (the problems with their
 *  days side by side) and Fix all. */
function showFixBar(it: Itinerary) {
  const bar = document.getElementById("fixBar");
  if (!bar || state.itinerary !== it || inline?.fix) return;
  const problems = planProblems(it);
  bar.hidden = !problems.length;
  if (!problems.length) return;
  const count = (k: Problem["kind"]) => problems.filter((p) => p.kind === k).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    count("dup") && plural(count("dup"), "duplicate", "duplicates"),
    count("hours") && plural(count("hours"), "stop closed when planned", "stops closed when planned"),
    count("far") && plural(count("far"), "stop in the wrong town", "stops in the wrong town"),
  ].filter(Boolean);
  const n = problems.length;
  bar.className = "fix-bar";
  // The message, then the two buttons as one group (on a narrow screen they go under it together, side by side).
  bar.innerHTML = `<span class="fix-msg">${icon("warn")}<span>${esc(parts.join(" · "))}</span></span>
    <span class="fix-acts"><button class="btn" data-review>Review</button>
    <button class="btn solid" data-fix title="The planner replaces each problem stop in one go; for duplicates the later day keeps the place">Fix ${n > 1 ? "all" : "it"}</button></span>`;
  bar.querySelector<HTMLButtonElement>("[data-review]")!.onclick = () => openReview();
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
    runGeneration({ fix: { itinerary: it, problems } });
  };
}

// The journal window changes what the itinerary shows (the Journal count, Planned / Actual).
setJournalRedraw(() => renderItinerary());
