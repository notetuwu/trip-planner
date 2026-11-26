// Generate, revise or re-plan one day: sends the trip, reads the server's NDJSON stream, and shows the result.
import { prefs } from "../core/prefs";
import { saveByItself } from "../saves/saves";
import type { Itinerary, RunResult, StreamEvent, TripRequest } from "../../../shared/types";
import { restoreAgreed } from "../../../shared/agreed";
import { $, apiFetch, toast } from "../core/dom";
import { type Meta, groupBudget, save, session, state, staysKey } from "../core/state";
import { geocodeItems } from "../geo/item-loc";
import { renderItinerary, resetFixOffer, setInlineProgress } from "../itinerary/render";
import { fmtDate } from "../core/format";
import { loadWeather } from "../itinerary/weather";
import { drawMap } from "../map/draw";
import { renderTripTitle } from "../trip/title";
import { setMapStatus } from "../map/status";
import { type Problem, checksSettled, planProblems, quickFixes } from "./autofix";
import { streamRequest } from "../core/progress";
import { byTitleMap, daySegments, exactPoi } from "../geo/item-loc";
import { addDays } from "../core/format";
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
function spliceFixed(current: Itinerary, data: RunResult, view: ProgressView, count: number, label?: string) {
  for (const fresh of data.itinerary.days || []) {
    const i = current.days.findIndex((d) => d.date === fresh.date);
    if (i >= 0) current.days[i] = { ...fresh, date: current.days[i].date };
  }
  current.totalEstimatedCost = current.days.reduce((n, d) => n + (Number(d.estimatedCost) || 0), 0);
  const meta = state.meta || {};
  const what = label || `Fixed ${count} problem${count > 1 ? "s" : ""} the map checks found`;
  const notes = `\n\n**${what}${data.itinerary.summary ? `:** ${data.itinerary.summary}` : ":**"}`
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
  // Settings → Planning: how many rounds (each checks again what the last fix changed).
  const rounds = prefs.fixRounds;
  for (let round = 1; round <= rounds; round++) {
    view.onEvent({ type: "status", text: `Checking the plan against the map and opening hours${round > 1 ? " again" : ""}…` });
    geocodeItems();
    const settled = await checksSettled(it, 120_000);
    setMapStatus("");
    if (!settled || signal.aborted) return;
    // A stop just before it opens moves to the opening time by itself; only what's left goes to the model.
    if (quickFixes(it)) { save(); await checksSettled(it, 30_000); }
    const problems = planProblems(it);
    if (!problems.length) break;
    view.onEvent({ type: "status", text: `Fixing ${problems.length} problem${problems.length > 1 ? "s" : ""} the checks found (wrong town or closed)${rounds > 1 ? `, round ${round} of ${rounds}` : ""}…` });
    const trip = { ...tripRequest({ fix: { itinerary: it, problems } }), research: false };
    try { spliceFixed(it, await request(trip, view, signal), view, problems.length); }
    catch (e) { if ((e as Error).name === "AbortError") throw e; break; /* keep the plan as it was; the Fix bar offers it again */ }
  }
  if (state.hoursOnline && !signal.aborted) await checkHoursOnline(it, view, signal);
}

/** Stops worth checking online: real places (not transfers, the hotel or "Lunch in town") whose opening hours
 *  OpenStreetMap doesn't know, at most 8 a day and 60 in all. */
function stopsToCheck(it: Itinerary) {
  const byTitle = byTitleMap(), out: { di: number; xi: number; place: string; town: string }[] = [];
  it.days.forEach((d, di) => {
    let n = 0;
    d.items.forEach((x, xi) => {
      if (n >= 8 || out.length >= 60 || x.kind === "transfer" || /→|->/.test(x.place) || /\bhotel\b|check[- ]?(in|out)/i.test(x.place)) return;
      if (/^(breakfast|brunch|lunch|dinner|coffee|free time|walk|stroll)\b/i.test(x.place) && !/\b(at|:)\s+\S/.test(x.place)) return;
      if (exactPoi(x, d, byTitle)?.hours) return; // checked against OpenStreetMap already
      out.push({ di, xi, place: x.place.replace(/\s*\([^)]*\)/g, "").trim(), town: daySegments(d)[0] || d.city });
      n++;
    });
  });
  return out;
}

/** "Check opening hours online": looks up the hours of the stops OpenStreetMap doesn't know, then sends each stay's
 *  days with what was found to the model, which moves or swaps only what's closed at the planned time. */
async function checkHoursOnline(it: Itinerary, view: ProgressView, signal: AbortSignal) {
  const stops = stopsToCheck(it);
  if (!stops.length) return;
  view.onEvent({ type: "status", text: `Looking up opening hours online for ${stops.length} stops…` });
  let found: string[] = [];
  try {
    ({ results: found } = await streamRequest<{ results: string[] }>("/api/hours/online", { stops: stops.map(({ place, town }) => ({ place, town })) },
      (l) => view.onEvent({ type: "status", text: l.status }), signal));
  } catch (e) { if ((e as Error).name === "AbortError") throw e; return; }
  // Per stay: the days it covers, each stop with what the web says about its hours.
  const stayOf = (date: string) => state.stays.findIndex((s) => s.start && date >= s.start && date < addDays(s.start, Number(s.nights) || 0));
  const byStay = new Map<number, Problem[]>();
  stops.forEach((s, i) => {
    if (!found[i]) return;
    const d = it.days[s.di], x = d.items[s.xi];
    const weekday = new Date(`${d.date}T12:00:00`).toLocaleDateString("en", { weekday: "long" });
    const list = byStay.get(stayOf(d.date)) || [];
    list.push({ day: s.di, text: `"${s.place}" at ${x.time || "?"} on ${weekday}: found online: ${found[i]}. If it's closed at that time on that weekday, move it to when it's open (or swap it with another stop that day, or a similar place that's open); if it's open or the results don't say, leave it exactly as it is.` });
    byStay.set(stayOf(d.date), list);
  });
  let k = 0;
  for (const [si, problems] of byStay) {
    if (signal.aborted) return;
    k++;
    const where = state.stays[si]?.city || "the trip";
    view.onEvent({ type: "status", text: `Checking ${where}'s days against the opening hours found online (${k} of ${byStay.size})…` });
    const trip = { ...tripRequest({ fix: { itinerary: it, problems } }), research: false };
    try { spliceFixed(it, await request(trip, view, signal), view, problems.length, `Checked ${where} against opening hours found online`); }
    catch (e) { if ((e as Error).name === "AbortError") throw e; }
  }
}

let running = false;
/** A plan, fix or change is being made right now (only one at a time). */
export const generationBusy = () => running;

/** Generates, revises, re-plans a day or fixes; true when the new plan is shown (false: cancelled, failed or busy). */
export async function runGeneration(change: Change = {}): Promise<boolean> {
  if (running) { toast("Still busy with the last change; try again when it's done."); return false; }
  const btn = $<HTMLButtonElement>("#generate");
  const trip = tripRequest(change);
  // Fixes and asked-for changes touch a few stops: no research round (the real places near each stay are in the prompt).
  if (change.fix || change.edit) trip.research = false;
  const redo = change.redoDay, fix = change.fix, edit = change.edit;
  const editDays = edit ? [...new Set(edit.days)].sort((a, b) => a - b) : [];
  const editWhat = editDays.length === 1 ? fmtDate(edit!.itinerary.days[editDays[0]]?.date || "") : `${editDays.length} days`;
  running = true; btn.disabled = true;
  const abort = new AbortController();
  // A day re-plan or a fix shows its progress inside the itinerary; the rest of the plan stays readable.
  const box = redo || fix || edit ? document.createElement("div") : undefined;
  if (box) {
    box.className = "inline-progress";
    setInlineProgress(redo ? { day: redo.day, el: box } : edit ? { days: editDays, el: box } : { fix: true, el: box });
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const view = showProgress({ into: box,
    who: modelLabel(state.model), local: isLocal(state.model), onCancel: () => abort.abort(),
    doing: redo ? `re-planning ${fmtDate(redo.itinerary.days[redo.day]?.date || "")}` : edit ? `changing ${editWhat}`
      : fix ? `fixing ${fix.problems.length} problem${fix.problems.length > 1 ? "s" : ""} the map checks found (wrong town or closed)` : change.revise ? "revising your trip" : "planning your trip",
    expectedDays: redo ? 1 : edit ? editDays.length : fix ? new Set(fix.problems.map((p) => p.day)).size : change.revise ? change.revise.itinerary.days.length : state.stays.reduce((n, s) => n + (+s.nights || 0), 0) + 1,
  });
  try {
    const data = await request(trip, view, abort.signal);
    setInlineProgress(null);
    if (redo && state.itinerary) spliceDay(state.itinerary, redo.day, data, view);
    else if (fix && state.itinerary) spliceFixed(state.itinerary, data, view, fix.problems.length);
    // Only the changed days come back; every other day stays exactly as it was.
    else if (edit && state.itinerary) {
      // What they agreed on with the chat is what they get: stops the planner left out (or tidied away) go back in.
      for (const d of data.itinerary.days || []) {
        const agreed = (edit.agreed || []).filter((a) => a.date === d.date);
        const back = agreed.length ? restoreAgreed(d, agreed) : 0;
        if (back) d.notes = `${d.notes ? `${d.notes} ` : ""}(${back} of the stops agreed in the chat ${back > 1 ? "were" : "was"} missing from the planner's version and ${back > 1 ? "were" : "was"} put back.)`;
      }
      spliceFixed(state.itinerary, data, view, 0, `Changed ${editWhat}: ${edit.request}`);
    }
    else {
      state.itinerary = data.itinerary;
      const meta: Meta = {
        costUsd: data.costUsd, durationMs: data.durationMs, reasoning: data.reasoning, thinking: data.thinking, ...view.collected,
        tokens: data.tokens, perSec: data.perSec, engine: data.engine, local: isLocal(trip.model), billing: data.billing,
        searches: data.searches, budget: groupBudget(), travelers: Number(state.travelers) || 1, currency: trip.currency, at: new Date().toISOString(), staysKey: staysKey(),
      };
      state.meta = meta;
      session.selectedDay = null;
      if (!change.revise) await fixBeforeShowing(state.itinerary, view, abort.signal);
      // Settings → General: keep each new plan in Saved trips by itself.
      if (prefs.app.autoSave) saveByItself().then((name) => { if (name) toast(`Saved as "${name}"`); });
    }
    session.weather = {};
    save();
    // The checks run again on what changed before the Fix bar says how many problems are left.
    resetFixOffer();
    view.stop();
    renderItinerary(); renderTripTitle(); drawMap({ fit: !redo && !fix && !edit }); geocodeItems(); loadWeather();
    if (redo) {
      document.getElementById(`day-${redo.day}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      toast(`${fmtDate(redo.itinerary.days[redo.day].date)} is re-planned`);
    } else if (fix) toast(`Fixed ${fix.problems.length} problem${fix.problems.length > 1 ? "s" : ""}`);
    else if (edit) {
      document.getElementById(`day-${editDays[0]}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      toast(`Changed ${editWhat}`);
    }
    return true;
  } catch (err) {
    setInlineProgress(null);
    view.stop();
    renderItinerary((err as Error).name === "AbortError" ? (fix || edit ? `${fix ? "Fixing" : "The change was"} cancelled; the plan is as it was.` : "Cancelled.") : (err as Error).message);
    return false;
  } finally {
    view.stop(); btn.disabled = false; running = false;
    window.dispatchEvent(new Event("ai-request-done")); // the quota line under the Model menu counts again
  }
}
