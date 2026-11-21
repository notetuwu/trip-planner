// "Plan a route": the travelers describe the trip (start, maybe an end, how many days, how they travel, what they want
// to see, what kind of stays); the selected model proposes the stays, and every leg is then checked against the real
// road route so overlong days are flagged instead of pretending they fit.
import type { LatLng } from "../../shared/types";
import { askModel } from "../ai/ask";
import { parseJsonLoose } from "../ai/output";
import { addDays } from "../config";
import { nominatim } from "../geo/providers";
import { waitForRoute } from "../geo/routing";
import type { Report } from "../util/progress-stream";

const MODES = ["car", "train", "bus", "bike", "ferry", "flight"] as const;
type Mode = (typeof MODES)[number] | "";

export interface RouteRequest {
  start: string;
  /** Where it ends; empty = back at the start. */
  end?: string;
  startDate: string;
  days: number;
  mode: Mode;
  maxHours: number;
  description: string;
  stays?: string;
  travelers?: number;
  interests?: string;
  model: string;
}
export interface PlannedStay { city: string; country: string; nights: number; travel: Mode; why: string; lat?: number; lng?: number }
export interface PlannedLeg { from: string; to: string; km?: number; hours?: number; tooLong: boolean; noRoad?: boolean }
export interface RoutePlan {
  title: string; summary: string; start: string; end: string; startDate: string;
  stays: PlannedStay[]; legs: PlannedLeg[]; nights: number;
}

const ROAD = new Set(["car", "bus", "bike"]);

/** Spreads the nights so they add up to the trip length: takes from (or adds to) stays with the most nights first. */
export function fitNights(stays: { nights: number }[], total: number) {
  if (!stays.length) return;
  let sum = stays.reduce((n, s) => n + s.nights, 0);
  while (sum > total) {
    const most = stays.reduce((a, b) => (b.nights > a.nights ? b : a));
    if (most.nights <= 1) break; // can't go below one night; the travelers see the stays are too many
    most.nights--; sum--;
  }
  for (let k = 0; sum < total; k = (k + 1) % stays.length) { stays[k].nights++; sum++; }
}

async function locate(q: string): Promise<LatLng | null> {
  try {
    const hits = await nominatim("search", new URLSearchParams({ q, format: "jsonv2", limit: "1", "accept-language": "en" }));
    return hits?.[0] ? [+hits[0].lat, +hits[0].lon] : null;
  } catch { return null; }
}

export async function planRoute(req: RouteRequest, report: Report = () => {}): Promise<RoutePlan> {
  const days = Math.min(120, Math.max(1, Math.round(Number(req.days) || 7)));
  const nights = days - 1;
  const end = (req.end || "").trim() || req.start;
  const roundTrip = end.toLowerCase() === req.start.trim().toLowerCase();
  const mode: Mode = (MODES as readonly string[]).includes(req.mode) ? req.mode : "";
  const maxHours = Math.min(14, Math.max(1, Number(req.maxHours) || 5));
  const howText = mode ? { car: "by car (they drive themselves)", train: "by train", bus: "by bus", bike: "by bike", ferry: "by ferry", flight: "by plane" }[mode] : "however suits each leg (car, train, bus, ferry or plane)";

  report({ type: "status", text: "Thinking up a route…" });
  const prompt = `Plan the route of a trip: where to stay each night. (A separate step plans the days themselves later.)

Start: ${req.start}${req.startDate ? `, leaving on ${req.startDate}` : ""}.
End: ${roundTrip ? `back at ${req.start} (a round trip)` : end}.
Length: ${days} days, so ${nights} nights away.
Travel: ${howText}; at most about ${maxHours} h of travel on a travel day.
${req.travelers ? `Travelers: ${req.travelers}. ` : ""}${req.interests ? `Interests: ${req.interests}.` : ""}
What they want: ${req.description || "a varied, scenic trip"}
${req.stays ? `Kind of places to stay: ${req.stays}` : ""}

Choose the stays in travel order, between the start and the end (not the start or end themselves). Give them ${nights} nights in total. Make it a real, drivable (or travelable) route: each leg within about ${maxHours} h, no zig-zagging, and the last stay within a day of the end. Spend 2-3 nights where there is a lot to see (so there are full days for day trips), 1 night for a stop on the way. Favour the places and regions they asked for; "maybe" means include it if it fits well.
Reply with only JSON:
{"title": "short trip name", "summary": "2-3 sentences on the route", "stays": [{"city": "town", "country": "country", "nights": 2, ${mode ? "" : `"travel": "car|train|bus|ferry|flight (how they get here from the previous place)", `}"why": "one short sentence: what's there and why stay"}]}`;

  const parsed = parseJsonLoose(await askModel(req.model, prompt, (n) => report({ type: "tokens", n })));
  const stays: PlannedStay[] = (Array.isArray(parsed?.stays) ? parsed.stays : [])
    .filter((s: any) => s && typeof s.city === "string" && s.city.trim())
    .slice(0, 60)
    .map((s: any) => ({
      city: s.city.trim(), country: String(s.country || "").trim(), nights: Math.max(1, Math.round(Number(s.nights) || 1)),
      travel: mode || ((MODES as readonly string[]).includes(s.travel) ? s.travel : "car"), why: String(s.why || "").slice(0, 240),
    }));
  if (!stays.length) throw new Error("The model didn't come back with a route. Try again, or describe the trip a bit more.");
  fitNights(stays, nights);

  // Where everything is, then the real road distance and time of each leg travelled by road.
  const places = [{ city: req.start, country: "" }, ...stays, { city: end, country: "" }];
  const coords: (LatLng | null)[] = [];
  for (const [k, p] of places.entries()) {
    report({ type: "status", text: `Checking where the stops are (${k + 1} of ${places.length})…` });
    coords.push(await locate(p.country ? `${p.city}, ${p.country}` : p.city));
  }
  stays.forEach((s, k) => { const c = coords[k + 1]; if (c) { s.lat = c[0]; s.lng = c[1]; } });
  const legs: PlannedLeg[] = [];
  for (let k = 1; k < places.length; k++) {
    const travel = k < places.length - 1 ? stays[k - 1].travel : (mode || stays.at(-1)!.travel);
    const leg: PlannedLeg = { from: places[k - 1].city, to: places[k].city, tooLong: false };
    const a = coords[k - 1], b = coords[k];
    if (a && b && ROAD.has(travel)) {
      report({ type: "status", text: `Checking the roads (${k} of ${places.length - 1})…` });
      const r = await waitForRoute("car", a, b, 25000).catch(() => undefined);
      if (r === null) leg.noRoad = true;
      else if (r) {
        leg.km = Math.round(r.d / 1000);
        leg.hours = Math.round(((travel === "bike" ? r.d / 1000 / 18 : r.t / 3600) * (travel === "bus" ? 1.2 : 1)) * 10) / 10;
        leg.tooLong = leg.hours > maxHours * 1.25;
      }
    }
    legs.push(leg);
  }
  return {
    title: String(parsed?.title || "").slice(0, 80), summary: String(parsed?.summary || "").slice(0, 600),
    start: req.start, end, startDate: req.startDate, stays, legs, nights,
  };
}

/** The trip's arrival date at each stay (from the start date and the nights before it). */
export const arrivals = (startDate: string, stays: { nights: number }[]) => {
  let d = startDate;
  return stays.map((s) => { const at = d; d = addDays(d, s.nights); return at; });
};
