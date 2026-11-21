// "Plan a route": the travelers describe the trip (start, maybe an end, how many days, how they travel, what they want
// to see, what kind of stays); the selected model proposes the stays, and every leg is then checked against the real
// road route so overlong days are flagged instead of pretending they fit.
import type { LatLng } from "../../shared/types";
import { askModel } from "../ai/ask";
import { parseJsonLoose } from "../ai/output";
import { addDays } from "../config";
import { locateTown } from "../geo/geocode";
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
export interface PlannedDayTrip { place: string; why: string }
export interface PlannedStay { city: string; country: string; nights: number; travel: Mode; why: string; dayTrips?: PlannedDayTrip[]; lat?: number; lng?: number }
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

/** Through the shared geocode cache, so the page finds the stays right away when the route is used. */
async function locate(q: string): Promise<LatLng | null> {
  try {
    const hit = await locateTown(q);
    return hit ? [hit.lat, hit.lng] : null;
  } catch { return null; }
}

const km = (a: LatLng, b: LatLng) => {
  const r = Math.PI / 180, x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * r), y = b[0] - a[0];
  return Math.hypot(x, y) * 111.2;
};
const length = (pts: LatLng[]) => pts.slice(1).reduce((n, p, k) => n + km(pts[k], p), 0);

/**
 * The order of the middle points (the first and last stay put) with no back and forth: reverses stretches of the
 * route while that makes it shorter (2-opt). Returns indexes into `pts`; the given order if it's already untangled.
 */
export function untangle(pts: LatLng[]): number[] {
  const order = pts.map((_, k) => k);
  const at = (k: number) => pts[order[k]];
  for (let better = true, rounds = 0; better && rounds < 50; rounds++) {
    better = false;
    for (let i = 1; i < order.length - 2; i++) for (let j = i + 1; j < order.length - 1; j++) {
      // Reversing order[i..j] swaps edges (i-1,i)+(j,j+1) for (i-1,j)+(i,j+1).
      const now = km(at(i - 1), at(i)) + km(at(j), at(j + 1)), then = km(at(i - 1), at(j)) + km(at(i), at(j + 1));
      if (then < now - 1) { order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse()); better = true; }
    }
  }
  return order;
}

/** What the page shows as the model's reasoning: its own thinking, the "reasoning" it writes first, then the stays so far. */
export function reasoningSoFar(reply: string, thinking: string) {
  const m = reply.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)/);
  let why = "";
  // Cut a half-written escape at the end ("\" or "\u00") so the piece still parses.
  if (m) try { why = JSON.parse(`"${m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`); } catch { why = m[1]; }
  const cities = [...reply.matchAll(/"city"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((c) => c[1]);
  return [thinking.trim(), why.trim(), cities.length ? `Stays so far: ${cities.join(" → ")}` : ""].filter(Boolean).join("\n\n");
}

export async function planRoute(req: RouteRequest, report: Report = () => {}, signal?: AbortSignal): Promise<RoutePlan> {
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

Choose the stays in travel order, between the start and the end (not the start or end themselves). Give them ${nights} nights in total. Make it a real, drivable (or travelable) route: each leg within about ${maxHours} h, and the last stay within a day of the end. Spend 2-3 nights where there is a lot to see (so there are full days for day trips), 1 night for a stop on the way. Favour the places and regions they asked for; "maybe" means include it if it fits well. People they want to visit (family, friends) get a stay where it fits the route.
The route must flow${roundTrip ? " as one loop" : " in one direction"}: each stay moves on from the last, and it never returns to a region it already left (no back and forth, no doubling back across a country). Group the stays by region and visit each region once.
Day trips: when they mention a place as a day trip ("a day trip to X", "a day in X"), or a place is small and close to a better base (a small country such as Liechtenstein, a single sight, a lake), don't make it a stay of its own: put it in "dayTrips" of a nearby stay that has 2+ nights. Only add day trips they asked for or that clearly fit what they want; most stays have none.
Reply with only JSON:
{"reasoning": "first, think it through in a few short sentences: the regions, the order of the loop, where the day trips go, how the nights split", "title": "short trip name", "summary": "2-3 sentences on the route", "stays": [{"city": "town", "country": "country", "nights": 2, ${mode ? "" : `"travel": "car|train|bus|ferry|flight (how they get here from the previous place)", `}"why": "one short sentence: what's there and why stay", "dayTrips": [{"place": "town or sight, country", "why": "a few words"}]}]}`;

  const parsed = parseJsonLoose(await askModel(req.model, prompt, (n) => report({ type: "tokens", n }), {
    signal, onText: (reply, thinking) => { const text = reasoningSoFar(reply, thinking); if (text) report({ type: "reasoning", text }); },
  }));
  const stays: PlannedStay[] = (Array.isArray(parsed?.stays) ? parsed.stays : [])
    .filter((s: any) => s && typeof s.city === "string" && s.city.trim())
    .slice(0, 60)
    .map((s: any) => ({
      city: s.city.trim(), country: String(s.country || "").trim(), nights: Math.max(1, Math.round(Number(s.nights) || 1)),
      travel: mode || ((MODES as readonly string[]).includes(s.travel) ? s.travel : "car"), why: String(s.why || "").slice(0, 240),
      dayTrips: (Array.isArray(s.dayTrips) ? s.dayTrips : [])
        .map((t: any) => (typeof t === "string" ? { place: t, why: "" } : { place: String(t?.place || ""), why: String(t?.why || "") }))
        .map((t: PlannedDayTrip) => ({ place: t.place.trim().slice(0, 100), why: t.why.trim().slice(0, 160) }))
        .filter((t: PlannedDayTrip) => t.place).slice(0, 3),
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
  // Models still double back now and then; with one way of travelling, put the stays in the shortest order instead.
  if (mode && coords.every(Boolean)) {
    const order = untangle(coords as LatLng[]);
    if (order.some((o, k) => o !== k) && length(order.map((o) => coords[o]!)) < length(coords as LatLng[]) * 0.95) {
      const moved = order.slice(1, -1).map((o) => stays[o - 1]);
      stays.splice(0, stays.length, ...moved);
      const c = order.map((o) => coords[o]);
      coords.splice(0, coords.length, ...c);
      places.splice(1, stays.length, ...stays);
      report({ type: "status", text: "Put the stays in an order without doubling back" });
    }
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
