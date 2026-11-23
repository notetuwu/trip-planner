// POST /api/itinerary: gathers holidays and real places, then plans with Claude or a local model, streaming
// progress as newline-delimited JSON (one "done" or "error" line at the end).
import type { Place, StreamEvent } from "../../shared/types";
import { runAnthropic } from "../ai/anthropic";
import { runClaude } from "../ai/claude";
import { runLocal } from "../ai/local";
import { runResponses } from "../ai/responses";
import { verifyWebsites } from "../ai/verify-links";
import type { Runner, Trip } from "../ai/types";
import { errMsg } from "../config";
import { reverseGeocode } from "../geo/search";
import { geoCache, geoKey, locateTown } from "../geo/geocode";
import { getList } from "../lists/store";
import { tripHolidays } from "../trip/holidays";
import { dropBookedAgain } from "../ai/output";
import { stayDaylight } from "../trip/daylight";
import { roadRoutes } from "../trip/drives";
import { nearbyPlaces } from "../trip/nearby";
import { type Req, type Res, readJson, sendJson } from "../util/http";

function validateTrip(t: Trip | null) {
  if (!t || !Array.isArray(t.stays) || !t.stays.length) return "Add at least one stay.";
  for (const s of t.stays) {
    if (!s.city || !s.start || !(Number(s.nights) >= 0)) return "Every stay needs a city, arrival date and number of nights.";
  }
  if (!(Number(t.dailyBudget) > 0)) return "Set a daily budget.";
  return null;
}

/** Local models, the Anthropic API, OpenAI/OpenRouter, or (by default) Claude Code. */
function runnerFor(model: string): Runner {
  if (model.startsWith("local|")) return runLocal;
  if (model.startsWith("api|anthropic|")) return runAnthropic;
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

/** The ticked lists' places plus the ones picked on the map. */
async function tripPlaces(trip: Trip): Promise<Place[]> {
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

export async function handleItinerary(req: Req, res: Res) {
  const trip: Trip | null = await readJson(req);
  if (!trip) return sendJson(res, 400, { error: "Invalid JSON" });
  const problem = validateTrip(trip);
  if (problem) return sendJson(res, 400, { error: problem });
  const places = await tripPlaces(trip);
  console.log(`${trip.redoDay ? `Re-planning day ${trip.redoDay.day + 1} of` : trip.edit ? `Changing ${trip.edit.days.length} day(s) of` : trip.fix ? `Fixing ${trip.fix.problems.length} problem(s) in` : trip.revise ? "Revising" : "Generating"} itinerary: ${trip.stays.map((s) => `${s.city} (${s.nights}n)`).join(" -> ")}`);

  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  const send = (ev: StreamEvent) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(ev) + "\n"); };
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  try {
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
    trip.nearby = await nearbyPlaces(trip.stays, `${trip.interests || ""} ${trip.notes || ""}`, (text) => send({ type: "status", text }));
    // The page uses these to put stops on the map at their exact spot.
    send({ type: "pois", places: trip.nearby.flatMap((n) => [...n.sights, ...n.food].map(({ name, lat, lng, hours, website }) => ({ name, lat, lng, city: n.city, hours, website }))) });
    const run = runnerFor(String(trip.model || ""));
    const result = await run(trip, places, send, abort.signal);
    dropBookedAgain(result.itinerary, trip.notes); // things they already booked aren't "book ahead"
    await verifyWebsites(result.itinerary, (text) => send({ type: "status", text }));
    console.log(`Done in ${(result.durationMs / 1000).toFixed(0)}s`);
    send({ type: "done", ...result });
  } catch (e) {
    console.error(errMsg(e));
    send({ type: "error", error: errMsg(e) });
  }
  res.end();
}
