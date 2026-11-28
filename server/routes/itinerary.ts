// POST /api/itinerary: gathers holidays and real places, then plans with Claude or a local model, streaming
// progress as newline-delimited JSON (one "done" or "error" line at the end).
import { researchWith } from "../research/research-model";
import { tune } from "../settings";
import type { Place, StreamEvent } from "../../shared/types";
import { runAnthropic } from "../ai/anthropic";
import { runClaude } from "../ai/claude";
import { runLocal } from "../ai/local";
import { runResponses } from "../ai/responses";
import { runGemini } from "../ai/gemini";
import { fixChecked, planChecked } from "../ai/checked/planner";
import { ensureOllama } from "../ai/ollama-start";
import { verifyWebsites } from "../ai/verify-links";
import type { Runner, Trip } from "../ai/types";
import { errMsg } from "../config";
import { reverseGeocode } from "../geo/search";
import { geoCache, geoKey, locateTown } from "../geo/geocode";
import { getList } from "../lists/store";
import { tripHolidays } from "../trip/holidays";
import { dropBookedAgain, ensureBookings } from "../ai/output";
import { stayDaylight } from "../trip/daylight";
import { roadRoutes } from "../trip/drives";
import { trainConnections } from "../trip/trains";
import { nearbyPlaces } from "../trip/nearby";
import { readPrefs } from "../trip/prefs";
import { type Req, type Res, readJson, sendJson } from "../util/http";
import { addDays } from "../config";

function validateTrip(t: Trip | null) {
  if (!t || !Array.isArray(t.stays) || !t.stays.length) return "Add at least one stay.";
  for (const s of t.stays) {
    if (!s.city || !s.start || !(Number(s.nights) >= 0)) return "Every stay needs a city, arrival date and number of nights.";
  }
  if (!(Number(t.dailyBudget) > 0)) return "Set a daily budget.";
  return null;
}

/** Local models, the Anthropic API, Google Gemini, OpenAI/OpenRouter, or (by default) Claude Code. */
export function runnerFor(model: string): Runner {
  if (model.startsWith("local|")) return runLocal;
  if (model.startsWith("api|anthropic|")) return runAnthropic;
  if (model.startsWith("api|gemini|")) return runGemini;
  if (model.startsWith("api|")) return runResponses;
  return runClaude;
}

const FAR_KM = 200;
const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * 6371;
};

/**
 * The places of every ticked list (merged; a place on two lists counts once), then only the ones the trip can reach:
 * with several lists (say one for Japan and one for the Alps) the far-away ones would only bloat the prompt. Places
 * more than 200 km from every stay go, unless they're must-sees or their location isn't known.
 */
export function mergeListPlaces(lists: Place[][], stays: { lat?: number; lng?: number }[], mustSee: string[] = []): Place[] {
  const seen = new Set<string>(), merged: Place[] = [];
  for (const p of lists.flat()) {
    const key = p.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key); merged.push(p);
  }
  const at = stays.filter((s): s is { lat: number; lng: number } => typeof s.lat === "number" && typeof s.lng === "number");
  if (!at.length) return merged;
  const must = new Set(mustSee);
  return merged.filter((p) => must.has(p.title) || typeof p.lat !== "number" || typeof p.lng !== "number"
    || at.some((s) => km(s, { lat: p.lat!, lng: p.lng! }) <= FAR_KM));
}

/** The days a re-plan, fix or change is about (dates), and the stays they touch (indexes); null for a whole plan. */
export function partialScope(trip: Trip): { dates: Set<string>; stays: Set<number> } | null {
  const it = trip.redoDay?.itinerary || trip.edit?.itinerary || trip.fix?.itinerary;
  if (!it) return null;
  const idx = trip.redoDay ? [trip.redoDay.day] : trip.edit ? trip.edit.days : trip.fix!.problems.map((p) => p.day);
  const dates = new Set(idx.map((i) => it.days[i]?.date).filter((d): d is string => !!d));
  const stays = new Set<number>();
  trip.stays.forEach((s, i) => {
    const end = addDays(s.start, Number(s.nights) || 0);
    if ([...dates].some((d) => d >= s.start && d <= end)) stays.add(i);
  });
  return { dates, stays };
}

/**
 * For a re-plan of some days: only what those days need. The prompt for re-planning the drive from Isny to Lucerne
 * shouldn't carry Milan's restaurants, Venice's sights and every must-see of the trip (which the model then tries to
 * fit into that one day). Places and must-sees go when they're far from the stays those days touch.
 */
export function scopeTrip(trip: Trip, places: Place[], scope: { dates: Set<string>; stays: Set<number> }) {
  const at = trip.stays.filter((_, i) => scope.stays.has(i)).filter((s): s is typeof s & { lat: number; lng: number } => typeof s.lat === "number" && typeof s.lng === "number");
  const near = (p: { lat?: number; lng?: number }) => typeof p.lat === "number" && typeof p.lng === "number" && at.some((s) => km(s, { lat: p.lat!, lng: p.lng! }) <= 80);
  const kept = at.length ? places.filter((p) => near(p) || (typeof p.lat !== "number" && !trip.mustSee?.includes(p.title))) : places;
  const keptTitles = new Set(kept.map((p) => p.title));
  trip.mustSee = (trip.mustSee || []).filter((t) => keptTitles.has(t));
  const cities = new Set(trip.stays.filter((_, i) => scope.stays.has(i)).map((s) => s.city.trim().toLowerCase()));
  if (trip.nearby) trip.nearby = trip.nearby.filter((n) => cities.has(n.city.trim().toLowerCase()));
  if (trip.holidays) trip.holidays = trip.holidays.filter((h) => scope.dates.has(h.date));
  if (trip.bookings) trip.bookings = trip.bookings.filter((b) => [...scope.dates].some((d) => d >= b.date && d <= (b.until || b.date)));
  if (trip.trains) trip.trains = trip.trains.filter((line) => [...cities].some((c) => line.toLowerCase().includes(c.split(",")[0])));
  return kept;
}

/** The ticked lists' places plus the ones picked on the map. */
export async function tripPlaces(trip: Trip): Promise<Place[]> {
  const extra = Array.isArray(trip.extraPlaces) ? trip.extraPlaces.filter((p) => p?.title) : [];
  // Older map-picked places were saved without an address; look it up so the model knows where they are.
  for (const p of extra) {
    if (!p.address && typeof p.lat === "number" && typeof p.lng === "number") {
      p.address = (await reverseGeocode(p.lat, p.lng).catch(() => null))?.short || "";
    }
  }
  const names = [...new Set([...(Array.isArray(trip.lists) ? trip.lists : []), trip.list].filter((n): n is string => typeof n === "string" && !!n))].slice(0, 20);
  const lists = await Promise.all(names.map(async (n) => (await getList(n))?.places || []));
  // Places from a CSV have no coordinates in the list file; the page looked them up meanwhile (same cache, same key),
  // so the planner gets where they are too.
  const cc = [...new Set(trip.stays.map((s) => s.cc).filter(Boolean))].join(",");
  const located = lists.map((l) => l.map((p) => {
    if (typeof p.lat === "number" && typeof p.lng === "number") return p;
    const hit = geoCache.data[geoKey(p.address || p.title, cc)] as { lat?: number; lng?: number } | number | null | undefined;
    return hit && typeof hit === "object" && typeof hit.lat === "number" ? { ...p, lat: hit.lat, lng: hit.lng } : p;
  }));
  return [...mergeListPlaces(located, trip.stays, trip.mustSee), ...extra];
}

/**
 * What the server gathers before any planner runs: where the stays are, holidays, daylight, real road routes and train
 * connections, and real places around the stays (only the ones a re-plan of some days needs). Returns the places left
 * for the plan. Exported for the checked planner's live test (tests/live).
 */
export async function prepareTrip(trip: Trip, places: Place[], scope: ReturnType<typeof partialScope>, send: (ev: StreamEvent) => void) {
  send({ type: "status", text: "Looking up holidays and real places near your stays…" });
  // Stays the page hadn't located (the request came too early, or from elsewhere): look them up here, since
  // holidays, daylight, nearby places and step-by-step planning all go by where the stays are.
  for (const s of trip.stays) {
    if (typeof s.lat === "number" && typeof s.lng === "number" || !s.city) continue;
    const hit = await locateTown(s.city, s.cc).catch(() => null);
    if (hit) Object.assign(s, { lat: hit.lat, lng: hit.lng, cc: s.cc || hit.cc, country: s.country || hit.country });
  }
  trip.holidays = await tripHolidays(trip.stays).catch(() => []);
  trip.daylight = await stayDaylight(trip.stays).catch(() => []);
  trip.drives = await roadRoutes(trip, (text) => send({ type: "status", text }));
  trip.trains = await trainConnections(trip, places, (text) => send({ type: "status", text })).catch(() => []);
  // What they wrote, read by the model into diets, allergies and the kinds of place they asked for (any language), so
  // the lists below can look for them; the trip's own setting for famous sights or hidden gems wins over the wishes.
  if (!trip.prefs) {
    send({ type: "status", text: "Reading your wishes…" });
    trip.prefs = await readPrefs(trip);
  }
  // (A copy: what readPrefs returns is its cache's, or the shared empty one.)
  if (trip.placeMix) trip.prefs = { ...trip.prefs, placeMix: trip.placeMix };
  // A re-plan of some days only needs the places around their stays.
  trip.nearby = await nearbyPlaces(scope ? trip.stays.filter((_, i) => scope.stays.has(i)) : trip.stays, trip.prefs, (text) => send({ type: "status", text }));
  if (scope) places = scopeTrip(trip, places, scope);
  // The page uses these to put stops on the map at their exact spot.
  send({ type: "pois", places: trip.nearby.flatMap((n) => [...n.sights, ...n.food, ...(n.wished || [])].map(({ name, lat, lng, hours, website }) => ({ name, lat, lng, city: n.city, hours, website }))) });
  return places;
}

/** Settings → Plan style → Planner: the checked planner makes whole new plans and takes the page's fix round for
 *  them (so one set of rules applies); re-planning a day, changes and revisions stay with the usual planner of the model. */
export const usesChecked = (trip: Trip, planner = tune().planner) => planner === "checked" && !trip.redoDay && !trip.edit && !trip.revise;

export async function handleItinerary(req: Req, res: Res) {
  const trip: Trip | null = await readJson(req);
  if (!trip) return sendJson(res, 400, { error: "Invalid JSON" });
  const problem = validateTrip(trip);
  if (problem) return sendJson(res, 400, { error: problem });
  let places = await tripPlaces(trip);
  const scope = partialScope(trip);
  console.log(`${trip.redoDay ? `Re-planning day ${trip.redoDay.day + 1} of` : trip.edit ? `Changing ${trip.edit.days.length} day(s) of` : trip.fix ? `Fixing ${trip.fix.problems.length} problem(s) in` : trip.revise ? "Revising" : "Generating"} itinerary: ${trip.stays.map((s) => `${s.city} (${s.nights}n)`).join(" -> ")}`);

  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  const send = (ev: StreamEvent) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(ev) + "\n"); };
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  try {
    places = await prepareTrip(trip, places, scope, send);
    // A research model of its own looks things up first; the planning model then doesn't search itself. If it can't,
    // the planning model researches as it would without one.
    let researched: Awaited<ReturnType<typeof researchWith>> | null = null;
    const researcher = tune().researchModel;
    if (trip.research && researcher) {
      try {
        researched = await researchWith(researcher, trip, places, send, abort.signal);
        if (!researched.notes) throw new Error("it found nothing");
        send({ type: "notes", text: `**Research findings**\n\n${researched.notes}` });
        trip.researchNotes = researched.notes;
        trip.research = false;
      } catch (e) {
        if (abort.signal.aborted) throw e;
        researched = null;
        send({ type: "status", text: `The research model didn't work (${errMsg(e).slice(0, 160)}), so the planning model researches…` });
      }
    }
    const checked = usesChecked(trip);
    // The checked planner talks to Ollama itself (runLocal would otherwise start it if it stopped).
    if (checked && String(trip.model || "").startsWith("local|ollama|") && !(await ensureOllama())) throw new Error("Ollama isn't running and couldn't be started. Start Ollama, then generate again.");
    const run = checked ? (trip.fix ? fixChecked : planChecked) : runnerFor(String(trip.model || ""));
    const result = await run(trip, places, send, abort.signal);
    if (researched) {
      result.reasoning = [`${researched.model} researched online first.`, result.reasoning].filter(Boolean).join("\n\n");
      result.searches = (result.searches || 0) + researched.searches;
      const cited = [...researched.urls, ...(researched.notes.match(/https?:\/\/[^\s\])>]+/g) || [])];
      if (!result.itinerary.sources?.length && cited.length) result.itinerary.sources = [...new Set(cited)];
    }
    dropBookedAgain(result.itinerary, trip.notes); // things they already booked aren't "book ahead"
    ensureBookings(result.itinerary, trip.bookings); // and their bookings are on their days
    await verifyWebsites(result.itinerary, (text) => send({ type: "status", text }));
    console.log(`Done in ${(result.durationMs / 1000).toFixed(0)}s`);
    send({ type: "done", ...result });
  } catch (e) {
    console.error(errMsg(e));
    send({ type: "error", error: errMsg(e) });
  }
  res.end();
}
