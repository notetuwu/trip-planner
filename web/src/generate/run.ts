// Generate, revise or re-plan one day: sends the trip, reads the server's NDJSON stream, and shows the result.
import type { Itinerary, RunResult, StreamEvent } from "../../../shared/types";
import { $, apiFetch } from "../core/dom";
import { type Meta, save, session, state } from "../core/state";
import { geocodeItems } from "../geo/item-loc";
import { renderItinerary } from "../itinerary/render";
import { loadWeather } from "../itinerary/weather";
import { drawMap } from "../map/draw";
import { renderTripTitle } from "../trip/title";
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

let running = false;

export async function runGeneration(change: Change = {}) {
  if (running) return;
  const btn = $<HTMLButtonElement>("#generate");
  const trip = tripRequest(change);
  const redo = change.redoDay;
  running = true; btn.disabled = true;
  const abort = new AbortController();
  const view = showProgress({
    who: modelLabel(state.model), local: isLocal(state.model), onCancel: () => abort.abort(),
    doing: redo ? `re-planning ${redo.itinerary.days[redo.day]?.date}` : change.revise ? "revising your trip" : "planning your trip",
    expectedDays: redo ? 1 : change.revise ? change.revise.itinerary.days.length : state.stays.reduce((n, s) => n + (+s.nights || 0), 0) + 1,
  });
  try {
    const res = await apiFetch("/api/itinerary", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(trip), signal: abort.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const data = await readStream(res, view.onEvent);
    if (!data) throw new Error("The server stopped before the plan was finished.");
    if (redo && state.itinerary) spliceDay(state.itinerary, redo.day, data, view);
    else {
      state.itinerary = data.itinerary;
      const meta: Meta = {
        costUsd: data.costUsd, durationMs: data.durationMs, reasoning: data.reasoning, thinking: data.thinking, ...view.collected,
        tokens: data.tokens, perSec: data.perSec, engine: data.engine, local: isLocal(trip.model), billing: data.billing,
        searches: data.searches, budget: trip.dailyBudget, currency: trip.currency, at: new Date().toISOString(),
      };
      state.meta = meta;
      session.selectedDay = null;
    }
    session.weather = {};
    save();
    renderItinerary(); renderTripTitle(); drawMap({ fit: !redo }); geocodeItems(); loadWeather();
  } catch (err) {
    renderItinerary((err as Error).name === "AbortError" ? "Cancelled." : (err as Error).message);
  } finally {
    view.stop(); btn.disabled = false; running = false;
  }
}
