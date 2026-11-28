// Live runs of the checked planner against a real model: not part of `npm test` (no network, no paid calls there).
// Run with `npm run test:live` and these environment variables:
//   TRIP_FILE   a saved trip (saves/<name>.json or current-trip.json): its stays, places and current plan
//   OUT_DIR     where to write the results (outside the repo: the trip is personal)
//   LIVE_PLAN=1 also make a new plan with the checked planner (else only the trip's current plan is scored)
//   STANDARD=1  make the plan with the usual planner of the model instead, scored by the same checks (the yardstick)
//   SAME_RESEARCH=1  reuse the research findings in the trip's last planning prompt instead of researching again,
//                    so both plans are compared on the same input
//   MODEL       the model id to plan with (default: the trip's own model)
//   GET_AROUND  how they get around in town (car, transit, mixed; default: the trip's own setting)
// Besides the metrics, OUT_DIR gets checked-trip.json: the saved trip with the new plan in it, to open in the app or
// to screenshot the map with (see tests/live/map.live.ts for the far-stops list).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Itinerary, MustSeeRoute, Place, TripRequest } from "../../shared/types";
import { routeFor } from "../../shared/route";
import { prepareTrip, runnerFor, tripPlaces } from "../../server/routes/itinerary";
import { contextFor, geoCached, planChecked } from "../../server/ai/checked/planner";
import { buildFrames, routeFrames } from "../../server/ai/checked/frames";
import { evaluatePlan } from "../../server/ai/checked/evaluate";
import { validatePlan } from "../../server/ai/checked/validate";
import { waitForRoute } from "../../server/geo/routing";
import type { Trip } from "../../server/ai/types";

const FILE = process.env.TRIP_FILE || "", OUT = process.env.OUT_DIR || "";
const route = async (a: { lat?: number; lng?: number }, b: { lat?: number; lng?: number }) => {
  if (typeof a.lat !== "number" || typeof b.lat !== "number") return undefined;
  const r = await waitForRoute("car", [a.lat, a.lng!], [b.lat, b.lng!], 30000).catch(() => undefined);
  return r ? { hours: r.t / 3600, km: Math.round(r.d / 1000) } : r;
};

/** The request the page would send for a saved trip (the parts the planner uses). */
function requestFrom(state: any): Trip {
  const marked = (m: string) => Object.keys(state.marks || {}).filter((t) => state.marks[t] === m);
  const extra: Place[] = (state.customPlaces || []).map(({ title, note, address, lat, lng }: any) => ({ title, note, address, lat, lng, picked: true }));
  return {
    stays: state.stays.map((s: any) => ({ city: s.city, start: s.start, nights: s.nights, hotel: s.hotel || "", travel: s.travel, dayTrips: s.dayTrips || [] })),
    dailyBudget: state.dailyBudget, budgetPer: state.budgetPer || "person", currency: state.currency, travelers: state.travelers, pace: state.pace,
    fitness: state.fitness, dayStart: state.dayStart, breakfast: state.breakfast, getAround: process.env.GET_AROUND || state.getAround, interests: state.interests, wishes: state.wishes,
    notes: state.notes, model: process.env.MODEL || state.model, list: state.list || "", lists: state.lists || [], extraPlaces: extra,
    research: false, bookings: state.bookings || [], mustSee: marked("must"), mustSeeWho: {}, skip: marked("skip"), people: state.people,
  } as unknown as TripRequest as Trip;
}

/** The research findings from the trip's last planning prompt. */
function lastResearch(state: any) {
  const prompt = (state.meta?.prompt || []).find((p: any) => /^Planning prompt/.test(p.label))?.text || "";
  const m = /## Web research findings[^\n]*\n([\s\S]*?)\n## /.exec(prompt);
  return m ? m[1].trim() : "";
}

describe.skipIf(!FILE || !OUT)("checked planner, live", () => {
  it("scores the trip's plan and (with LIVE_PLAN) makes a checked one", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    // A save file wraps the state; a version from saves/.history is the state itself.
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const saved = raw.state ? raw : { state: raw };
    const state = saved.state;
    const trip = requestFrom(state);
    const send = (ev: any) => { if (ev.type === "status") console.log(ev.text); };
    const places = await prepareTrip(trip, await tripPlaces(trip), null, send);
    // The must-sees' place on the route, as the page works it out, with the travelers' "on the way" choices.
    const located = trip.stays.map((s) => (typeof s.lat === "number" ? { city: s.city, start: s.start, nights: Number(s.nights), lat: s.lat, lng: s.lng! } : null));
    trip.mustSeeRoute = Object.fromEntries(trip.mustSee.map((t) => {
      const p = places.find((x) => x.title === t);
      const r: MustSeeRoute = p && typeof p.lat === "number" ? routeFor({ lat: p.lat, lng: p.lng! }, located) : { onWay: false };
      return [t, { ...r, ...(state.how?.[t] ? { how: state.how[t] } : {}) }];
    }));
    if (process.env.SAME_RESEARCH) trip.researchNotes = lastResearch(state);

    const frames = buildFrames(trip, places);
    await routeFrames(frames, trip, route);
    const setup = { trip, places, frames, route, geo: geoCached };
    const baseline = structuredClone(state.itinerary) as Itinerary;
    const { ctx: baseCtx } = await contextFor(setup, baseline.days);
    const before = evaluatePlan(baseline, baseCtx, trip.holidays);
    fs.writeFileSync(path.join(OUT, "baseline-issues.json"), JSON.stringify(validatePlan(baseline.days, baseCtx).filter((x) => x.code !== "no-duration"), null, 1));
    fs.writeFileSync(path.join(OUT, "baseline-metrics.json"), JSON.stringify({ engine: state.meta?.engine, durationMs: state.meta?.durationMs, tokens: state.meta?.tokens, metrics: before }, null, 1));
    fs.writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(frames, null, 1));
    console.log("baseline", JSON.stringify(before));
    expect(before.expectedDays).toBeGreaterThan(0);
    if (!process.env.LIVE_PLAN) return;

    const events: any[] = [];
    const abort = new AbortController();
    const standard = !!process.env.STANDARD, tag = standard ? "standard" : "checked";
    const result = standard
      ? await runnerFor(String(trip.model || ""))(trip, places, (ev) => { events.push(ev); if (ev.type === "status") console.log(ev.text); }, abort.signal)
      : await planChecked(trip, places, (ev) => { events.push(ev); if (ev.type === "status") console.log(ev.text); }, abort.signal, route);
    const { ctx: afterCtx } = await contextFor(setup, structuredClone(result.itinerary.days));
    const after = evaluatePlan(result.itinerary, afterCtx, trip.holidays);
    fs.writeFileSync(path.join(OUT, `${tag}-issues.json`), JSON.stringify(validatePlan(result.itinerary.days, afterCtx), null, 1));
    fs.writeFileSync(path.join(OUT, `${tag}-itinerary.json`), JSON.stringify(result.itinerary, null, 1));
    fs.writeFileSync(path.join(OUT, `${tag}-result.json`), JSON.stringify({ engine: result.engine, durationMs: result.durationMs, tokens: result.tokens, checks: result.checks, reasoning: result.reasoning, metrics: after }, null, 1));
    fs.writeFileSync(path.join(OUT, `${tag}-prompts.json`), JSON.stringify(events.filter((e) => e.type === "prompt"), null, 1));
    // The trip as the app would save it with this plan, to open or to screenshot.
    const pois = events.filter((e) => e.type === "pois").flatMap((e) => e.places);
    fs.writeFileSync(path.join(OUT, `${tag}-trip.json`), JSON.stringify({ ...saved, state: { ...state, itinerary: result.itinerary, meta: { ...(state.meta || {}), engine: result.engine, reasoning: result.reasoning, checks: result.checks, pois: pois.length ? pois : state.meta?.pois, prompt: events.filter((e) => e.type === "prompt") } } }));
    console.log(tag, JSON.stringify(after));
    expect(after.datesCovered).toBe(after.expectedDays);
  }, 3 * 60 * 60_000);
});
