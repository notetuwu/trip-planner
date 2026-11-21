// Generate, revise or re-plan one day: sends the trip, reads the server's NDJSON stream, and shows the result.
import type { Itinerary, RunResult, StreamEvent, TripRequest } from "../../../shared/types";
import { $, apiFetch, toast } from "../core/dom";
import { type Meta, save, session, state } from "../core/state";
import { geocodeItems } from "../geo/item-loc";
import { renderItinerary, setInlineProgress } from "../itinerary/render";
import { fmtDate } from "../core/format";
import { loadWeather } from "../itinerary/weather";
import { drawMap } from "../map/draw";
import { renderTripTitle } from "../trip/title";
import { setMapStatus } from "../map/status";
import { checksSettled, planProblems } from "./autofix";
import { isLocal, modelLabel } from "./models";
import { type ProgressView, showProgress } from "./progress";
import { type Change, tripRequest } from "./request";

/** Reads one JSON object per line; returns the final "done" event. */
async function readStream(res: Response, onEvent: (ev: StreamEvent) => void): Promise<RunResult | null> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const ev: StreamEvent = JSON.parse(line);
      if (ev.type === "error") throw new Error(ev.error);
      if (ev.type === "done") return ev;
      onEvent(ev);
    }
  }
}

/** Swaps the re-planned day into the current itinerary and adds its notes to the reasoning. */
function spliceDay(current: Itinerary, day: number, data: RunResult, view: ProgressView) {
  const old = current.days[day], fresh = data.itinerary.days[0];
  if (!fresh) throw new Error("The model didn't return the day.");
  current.days[day] = { ...fresh, date: old.date };
  current.totalEstimatedCost = current.days.reduce((n, d) => n + (Number(d.estimatedCost) || 0), 0);
  const meta = state.meta || {};
  const notes = data.reasoning ? `\n\n**Re-planned ${old.date}${data.itinerary.summary ? `:** ${data.itinerary.summary}` : ":**"}\n\n${data.reasoning}` : "";
  state.meta = { ...meta, reasoning: (meta.reasoning || "") + notes, pois: [...(meta.pois || []), ...view.collected.pois] };
}

/** Swaps the fixed days in (matched by date) and notes what was fixed. */
function spliceFixed(current: Itinerary, data: RunResult, view: ProgressView, count: number) {
  for (const fresh of data.itinerary.days || []) {
    const i = current.days.findIndex((d) => d.date === fresh.date);
    if (i >= 0) current.days[i] = { ...fresh, date: current.days[i].date };
  }
  current.totalEstimatedCost = current.days.reduce((n, d) => n + (Number(d.estimatedCost) || 0), 0);
  const meta = state.meta || {};
  const notes = `\n\n**Fixed ${count} problem${count > 1 ? "s" : ""} the map checks found${data.itinerary.summary ? `:** ${data.itinerary.summary}` : ":**"}`
    + (data.reasoning ? `\n\n${data.reasoning}` : "");
  state.meta = { ...meta, reasoning: (meta.reasoning || "") + notes, pois: [...(meta.pois || []), ...view.collected.pois],
    costUsd: meta.costUsd != null || data.costUsd != null ? (meta.costUsd || 0) + (data.costUsd || 0) : undefined };
}

/** Sends a trip request and reads the answer (progress goes to the view). */
async function request(trip: TripRequest, view: ProgressView, signal: AbortSignal) {
  const res = await apiFetch("/api/itinerary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(trip), signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const data = await readStream(res, view.onEvent);
  if (!data) throw new Error("The server stopped before the plan was finished.");
  return data;
}

/** Before a fresh plan is shown: check it against the map and opening hours, and have the model fix what the checks
 *  find (one round), so the plan you get is already fixed. Anything left shows the Fix bar, which runs only on a click. */
async function fixBeforeShowing(it: Itinerary, view: ProgressView, signal: AbortSignal) {
  if (state.autoFix === false) return;
  view.onEvent({ type: "status", text: "Checking the plan against the map and opening hours…" });
  geocodeItems();
  const settled = await checksSettled(it, 120_000);
  setMapStatus("");
  if (!settled || signal.aborted) return;
  const problems = planProblems(it);
  if (!problems.length) return;
  view.onEvent({ type: "status", text: `Fixing ${problems.length} problem${problems.length > 1 ? "s" : ""} the checks found (wrong town or closed)…` });
  const trip = { ...tripRequest({ fix: { itinerary: it, problems } }), research: false };
  try { spliceFixed(it, await request(trip, view, signal), view, problems.length); }
  catch (e) { if ((e as Error).name === "AbortError") throw e; /* keep the plan as it was; the Fix bar offers it again */ }
}

let running = false;

export async function runGeneration(change: Change = {}) {
  if (running) return;
  const btn = $<HTMLButtonElement>("#generate");
  const trip = tripRequest(change);
  if (change.fix) trip.research = false;
  const redo = change.redoDay, fix = change.fix;
  running = true; btn.disabled = true;
  const abort = new AbortController();
  // A day re-plan or a fix shows its progress inside the itinerary; the rest of the plan stays readable.
  const box = redo || fix ? document.createElement("div") : undefined;
  if (box) { box.className = "inline-progress"; setInlineProgress(redo ? { day: redo.day, el: box } : { fix: true, el: box }); }
  const view = showProgress({ into: box,
    who: modelLabel(state.model), local: isLocal(state.model), onCancel: () => abort.abort(),
    doing: redo ? `re-planning ${fmtDate(redo.itinerary.days[redo.day]?.date || "")}`
      : fix ? `fixing ${fix.problems.length} problem${fix.problems.length > 1 ? "s" : ""} the map checks found (wrong town or closed)` : change.revise ? "revising your trip" : "planning your trip",
    expectedDays: redo ? 1 : fix ? new Set(fix.problems.map((p) => p.day)).size : change.revise ? change.revise.itinerary.days.length : state.stays.reduce((n, s) => n + (+s.nights || 0), 0) + 1,
  });
  try {
    const data = await request(trip, view, abort.signal);
    setInlineProgress(null);
    if (redo && state.itinerary) spliceDay(state.itinerary, redo.day, data, view);
    else if (fix && state.itinerary) spliceFixed(state.itinerary, data, view, fix.problems.length);
    else {
      state.itinerary = data.itinerary;
      const meta: Meta = {
        costUsd: data.costUsd, durationMs: data.durationMs, reasoning: data.reasoning, thinking: data.thinking, ...view.collected,
        tokens: data.tokens, perSec: data.perSec, engine: data.engine, local: isLocal(trip.model), billing: data.billing,
        searches: data.searches, budget: trip.dailyBudget, currency: trip.currency, at: new Date().toISOString(),
      };
      state.meta = meta;
      session.selectedDay = null;
      if (!change.revise) await fixBeforeShowing(state.itinerary, view, abort.signal);
    }
    session.weather = {};
    save();
    renderItinerary(); renderTripTitle(); drawMap({ fit: !redo && !fix }); geocodeItems(); loadWeather();
    if (redo) {
      document.getElementById(`day-${redo.day}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      toast(`${fmtDate(redo.itinerary.days[redo.day].date)} is re-planned`);
    } else if (fix) toast(`Fixed ${fix.problems.length} problem${fix.problems.length > 1 ? "s" : ""}`);
  } catch (err) {
    setInlineProgress(null);
    renderItinerary((err as Error).name === "AbortError" ? (fix ? "Fixing cancelled; the plan is as it was." : "Cancelled.") : (err as Error).message);
  } finally {
    view.stop(); btn.disabled = false; running = false;
  }
}
