// Generate or revise: sends the trip, reads the server's NDJSON stream, and shows the finished itinerary.
import type { Itinerary, RunResult, StreamEvent } from "../../../shared/types";
import { $, apiFetch } from "../core/dom";
import { save, session, state } from "../core/state";
import { geocodeItems } from "../geo/item-loc";
import { renderItinerary } from "../itinerary/render";
import { loadWeather } from "../itinerary/weather";
import { drawMap } from "../map/draw";
import { renderTripTitle } from "../trip/title";
import { isLocal, modelLabel } from "./models";
import { showProgress } from "./progress";
import { tripRequest } from "./request";

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

export async function runGeneration(revise?: { itinerary: Itinerary; request: string }) {
  const btn = $<HTMLButtonElement>("#generate");
  const trip = tripRequest(revise);
  btn.disabled = true;
  const abort = new AbortController();
  const view = showProgress({
    who: modelLabel(state.model), revising: !!revise, local: isLocal(state.model), onCancel: () => abort.abort(),
    expectedDays: revise ? revise.itinerary.days.length : state.stays.reduce((n, s) => n + (+s.nights || 0), 0) + 1,
  });
  try {
    const res = await apiFetch("/api/itinerary", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(trip), signal: abort.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const data = await readStream(res, view.onEvent);
    if (!data) throw new Error("The server stopped before the plan was finished.");
    state.itinerary = data.itinerary;
    state.meta = {
      costUsd: data.costUsd, durationMs: data.durationMs, reasoning: data.reasoning, thinking: data.thinking, ...view.collected,
      tokens: data.tokens, perSec: data.perSec, engine: data.engine, local: isLocal(trip.model),
      budget: trip.dailyBudget, currency: trip.currency, at: new Date().toISOString(),
    };
    session.selectedDay = null; session.weather = {};
    save();
    renderItinerary(); renderTripTitle(); drawMap({ fit: true }); geocodeItems(); loadWeather();
  } catch (err) {
    renderItinerary((err as Error).name === "AbortError" ? "Cancelled." : (err as Error).message);
  } finally {
    view.stop(); btn.disabled = false;
  }
}
