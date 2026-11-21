// Renders the itinerary column and wires up its buttons.
import { $, $$, downloadFile, esc } from "../core/dom";
import { save, session, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { downloadForPhone } from "../export/offline";
import { runGeneration } from "../generate/run";
import { renderDayChips, selectDay } from "../map/days";
import { drawMap } from "../map/draw";
import { removeStop } from "../map/edit";
import { updateLegInfo } from "../map/legs";
import { renderTripTitle } from "../trip/title";
import { itineraryIcs } from "../export/ics";
import { wireBookAhead } from "./book-ahead";
import { daysHtml, extrasHtml } from "./days-html";
import { checkOpeningHours } from "./hours";
import { summaryHtml } from "./summary";

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
  for (const el of $$("[data-sel]", out)) el.onclick = (e) => { if (!(e.target as HTMLElement).closest("a")) selectDay(+el.dataset.sel!); };
  for (const el of $$("[data-bar]", out)) el.onclick = () => selectDay(+el.dataset.bar!, { scroll: true });
  for (const el of $$("[data-del]", out)) el.onclick = () => { const [d, x] = el.dataset.del!.split("-"); removeStop(+d, +x); };
}

export function renderItinerary(error?: string) {
  const it = state.itinerary, meta = state.meta || {};
  const out = $("#output");
  const errorHtml = error ? `<div class="error">${esc(error)}</div>` : "";
  if (!it) {
    out.innerHTML = errorHtml + `<div class="empty"><div class="sun"></div>Add your stays, pick a place list, and generate.<br>Your itinerary will appear here.</div>`;
    renderDayChips();
    return;
  }
  const cur = meta.currency || state.currency;
  const budget = meta.budget || state.dailyBudget;
  const byTitle = byTitleMap();
  out.innerHTML = errorHtml + summaryHtml(it, byTitle, cur, budget) + daysHtml(it, byTitle, cur, budget) + extrasHtml(it);
  wire(out);
  updateLegInfo();
  checkOpeningHours();
}
