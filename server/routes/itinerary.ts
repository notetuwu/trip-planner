// POST /api/itinerary: gathers holidays and real places, then plans with Claude or a local model, streaming
// progress as newline-delimited JSON (one "done" or "error" line at the end).
import type { Place, StreamEvent } from "../../shared/types";
import { runClaude } from "../ai/claude";
import { runLocal } from "../ai/local";
import type { Trip } from "../ai/types";
import { errMsg } from "../config";
import { reverseGeocode } from "../geo/search";
import { getList } from "../lists/store";
import { tripHolidays } from "../trip/holidays";
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

/** The selected list's places plus the ones picked on the map. */
async function tripPlaces(trip: Trip): Promise<Place[]> {
  const extra = Array.isArray(trip.extraPlaces) ? trip.extraPlaces.filter((p) => p?.title) : [];
  // Older map-picked places were saved without an address; look it up so the model knows where they are.
  for (const p of extra) {
    if (!p.address && typeof p.lat === "number" && typeof p.lng === "number") {
      p.address = (await reverseGeocode(p.lat, p.lng).catch(() => null))?.short || "";
    }
  }
  return [...(trip.list ? (await getList(trip.list))?.places || [] : []), ...extra];
}

export async function handleItinerary(req: Req, res: Res) {
  const trip: Trip | null = await readJson(req);
  if (!trip) return sendJson(res, 400, { error: "Invalid JSON" });
  const problem = validateTrip(trip);
  if (problem) return sendJson(res, 400, { error: problem });
  const places = await tripPlaces(trip);
  console.log(`${trip.revise ? "Revising" : "Generating"} itinerary: ${trip.stays.map((s) => `${s.city} (${s.nights}n)`).join(" -> ")}`);

  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  const send = (ev: StreamEvent) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(ev) + "\n"); };
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  try {
    send({ type: "status", text: "Looking up holidays and real places near your stays…" });
    trip.holidays = await tripHolidays(trip.stays).catch(() => []);
    trip.nearby = await nearbyPlaces(trip.stays, `${trip.interests || ""} ${trip.notes || ""}`, (text) => send({ type: "status", text }));
    // The page uses these to put stops on the map at their exact spot.
    send({ type: "pois", places: trip.nearby.flatMap((n) => [...n.sights, ...n.food].map(({ name, lat, lng }) => ({ name, lat, lng, city: n.city }))) });
    const run = String(trip.model || "").startsWith("local|") ? runLocal : runClaude;
    const result = await run(trip, places, send, abort.signal);
    console.log(`Done in ${(result.durationMs / 1000).toFixed(0)}s`);
    send({ type: "done", ...result });
  } catch (e) {
    console.error(errMsg(e));
    send({ type: "error", error: errMsg(e) });
  }
  res.end();
}
