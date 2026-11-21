// Renders the itinerary column and wires up its buttons.
import { $, $$, downloadFile, esc } from "../core/dom";
import { save, session, state } from "../core/state";
import { byTitleMap } from "../geo/item-loc";
import { downloadForPhone } from "../export/offline";
import { runGeneration } from "../generate/run";
import { renderDayChips, selectDay } from "../map/days";
import { drawMap } from "../map/draw";
import { removeStop } from "../map/edit";
import { updateLegInfo } from "../map/legs";
import { renderTripTitle } from "../trip/title";
import { daysHtml, extrasHtml } from "./days-html";
import { summaryHtml } from "./summary";

function clearItinerary() {
  state.itinerary = null; state.meta = null; session.selectedDay = null;
  save(); renderItinerary(); renderTripTitle(); drawMap({ fit: true });
}

function wire(out: HTMLElement) {
  const tools: Record<string, () => void> = {
    phone: downloadForPhone,
    print: () => window.print(),
    json: () => downloadFile(new Blob([JSON.stringify(state.itinerary, null, 2)], { type: "application/json" }), "itinerary.json"),
    clear: () => { if (confirm("Clear this itinerary?")) clearItinerary(); },
  };
  for (const b of $$("[data-tool]", out)) b.onclick = tools[b.dataset.tool!];
  out.querySelector('[data-stale="clear"]')?.addEventListener("click", clearItinerary);
  out.querySelector('[data-stale="gen"]')?.addEventListener("click", () => runGeneration());
  $("#refineBtn").onclick = () => {
    const request = $<HTMLTextAreaElement>("#refineText").value.trim();
    if (request && state.itinerary) runGeneration({ itinerary: state.itinerary, request });
  };
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
}
