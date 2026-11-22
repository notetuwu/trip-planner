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
import { townAt } from "./stops";

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
  /** Spending per day for everything (stays included), in `currency`. */
  budget?: number;
  currency?: string;
  model: string;
  /**
   * When they're changing a route: each route suggested so far ("Salzburg (2 nights) → …") and what they said about it.
   * The last one is the route on screen, with what they want changed now.
   */
  conversation?: { route: string; said?: string }[];
  /** Places they starred, to plan the route around; `how`: on the way between stays, or from a stay. */
  mustSee?: { name: string; lat?: number; lng?: number; how?: "way" | "stay" }[];
}
/** `way`: they asked to see it on the way, so it becomes a stop on a travel day rather than a day trip. */
export interface PlannedDayTrip { place: string; why: string; way?: boolean; home?: boolean; lat?: number; lng?: number }
export interface PlannedStay { city: string; country: string; nights: number; travel: Mode; why: string; dayTrips?: PlannedDayTrip[]; lat?: number; lng?: number }
/** A sight between two stays, visited on the travel day. */
export interface WayStop { place: string; why: string; lat: number; lng: number }
export interface PlannedLeg { from: string; to: string; km?: number; hours?: number; tooLong: boolean; noRoad?: boolean; via?: WayStop[] }
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

const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** The town's own name ("Lindau, Germany" → "lindau") appears in what they wrote. */
const named = (city: string, text: string) => { const c = norm(city.split(",")[0]); return !!c && ` ${norm(text)} `.includes(` ${c} `); };

/**
 * Two stays within `km` of each other are one stay: keeps the one they named in the description (else the one with
 * more nights, else the first) and gives it the other's nights and day trips. Stays need lat/lng; changes `stays`.
 */
export function mergeClose(stays: PlannedStay[], description: string, maxKm = 30) {
  for (let i = 0; i < stays.length; i++) for (let j = i + 1; j < stays.length; j++) {
    const a = stays[i], b = stays[j];
    if (a.lat == null || b.lat == null || km([a.lat, a.lng!], [b.lat, b.lng!]) > maxKm) continue;
    const keepB = (named(b.city, description) && !named(a.city, description)) || (named(b.city, description) === named(a.city, description) && b.nights > a.nights);
    const [keep, drop] = keepB ? [b, a] : [a, b];
    keep.nights += drop.nights;
    keep.dayTrips = [...(keep.dayTrips || []), ...(drop.dayTrips || [])];
    stays.splice(stays.indexOf(drop), 1);
    i = -1; break; // start over: the indexes moved
  }
}

/**
 * Where each day trip really belongs, now that everything is on the map. Places they asked to see on the way go on the
 * leg they add the least detour to. A day trip that lies on the way between two places becomes a stop on that travel
 * day too when they named it themselves (and it isn't right by a stay), or when it's far from every stay but hardly a
 * detour; every other day trip goes from the closest stay (one with 2+ nights if that's hardly further). `points` are the start, the stays and the end; returns the stops on the way by leg.
 */
export function placeTrips(points: LatLng[], stays: PlannedStay[], description = "", wayAt: LatLng[] = []): Map<number, WayStop[]> {
  // A starred place they marked "on the way" is a stop on the way, whatever list the model put it in.
  for (const s of stays) for (const t of s.dayTrips || []) if (t.lat != null && wayAt.some((w) => km(w, [t.lat!, t.lng!]) < 2)) t.way = true;
  const trips = stays.flatMap((s) => (s.dayTrips || []).map((t) => ({ t, from: s })));
  for (const s of stays) s.dayTrips = [];
  const via = new Map<number, WayStop[]>();
  const located = stays.filter((s) => s.lat != null);
  for (const { t, from } of trips) {
    // Not found on the map: it stays where the model put it.
    if (t.lat == null || !located.length) { if (!t.way) (from.dayTrips ||= []).push(t); continue; }
    const at: LatLng = [t.lat, t.lng!];
    const dist = (s: PlannedStay) => km(at, [s.lat!, s.lng!]);
    const nearest = located.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    const roomy = located.filter((s) => s.nights >= 2).reduce<PlannedStay | null>((a, b) => (!a || dist(b) < dist(a) ? b : a), null);
    let leg = -1, best = Infinity, tight = false;
    for (let k = 0; k < points.length - 1; k++) {
      const ab = km(points[k], points[k + 1]), detour = km(points[k], at) + km(at, points[k + 1]) - ab;
      // Straight lines flatter detours (Hallstatt looks "on the way" from Salzburg to Venice; by road it isn't), so
      // "hardly a detour" means really small: 15 km, or a tenth of a long leg.
      if ((t.way || (ab > 30 && detour < Math.max(15, ab * 0.25))) && detour < best) { best = detour; leg = k; tight = detour < Math.max(15, ab * 0.1); }
    }
    // A long way there and back from any stay, but hardly out of the way on a drive they make anyway (Neuschwanstein
    // between Innsbruck and the Allgäu): a stop on that drive, even if the model suggested it.
    const farButOnTheWay = dist(nearest) > 45 && tight; // 45 km in a straight line is often 1-2 h by road in the mountains
    // A day trip stays a day trip (the model was told what they asked for, "day trip" or "on the way"), unless it's a
    // long way from every stay and hardly off a drive they make anyway.
    if (t.home) { leg = points.length - 2; } // listed for the drive home: that leg, whatever a straight line suggests
    if (leg >= 0 && (t.way || farButOnTheWay)) {
      via.set(leg, [...(via.get(leg) || []), { place: t.place, why: t.why, lat: t.lat, lng: t.lng! }]);
      continue;
    }
    const base = roomy && nearest.nights < 2 && dist(roomy) <= dist(nearest) * 1.5 + 10 ? roomy : nearest;
    (base.dayTrips ||= []).push(t);
  }
  return via;
}

/** A place name as given, then simpler: the part in brackets, then without it (each keeping the country at the end). */
export function nameForms(place: string): string[] {
  const m = place.match(/^(.*?)\s*\(([^)]*)\)\s*(.*)$/);
  if (!m) return [place];
  const [, before, inside, after] = m, country = after.replace(/^,\s*/, "");
  const withCountry = (t: string) => (country ? `${t.trim()}, ${country}` : t.trim());
  return [...new Set([place, withCountry(inside), withCountry(before)].filter((q) => q.replace(/[,\s]/g, "")))];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export async function planRoute(req: RouteRequest, report: Report = () => {}, signal?: AbortSignal): Promise<RoutePlan> {
  const days = Math.min(120, Math.max(1, Math.round(Number(req.days) || 7)));
  const nights = days - 1;
  const end = (req.end || "").trim() || req.start;
  const roundTrip = end.toLowerCase() === req.start.trim().toLowerCase();
  const mode: Mode = (MODES as readonly string[]).includes(req.mode) ? req.mode : "";
  const maxHours = Math.min(14, Math.max(1, Number(req.maxHours) || 5));
  const howText = mode ? { car: "by car (they drive themselves)", train: "by train", bus: "by bus", bike: "by bike", ferry: "by ferry", flight: "by plane" }[mode] : "however suits each leg (car, train, bus, ferry or plane)";

  // An address means nothing to the model on its own: say which town it's in.
  const whereIs = async (q: string) => {
    const at = await locate(q);
    const t = at && (await townAt(at));
    return { at, text: t && !norm(q).includes(norm(t.name)) ? `${q} (in ${t.name}${t.country ? `, ${t.country}` : ""})` : q };
  };
  report({ type: "status", text: "Finding the start…" });
  const from = await whereIs(req.start);
  const to = roundTrip ? from : await whereIs(end);
  const month = req.startDate ? MONTHS[Number(req.startDate.slice(5, 7)) - 1] : "";

  const conv = (Array.isArray(req.conversation) ? req.conversation : []).slice(-8)
    .map((t) => ({ route: String(t?.route || "").trim().slice(0, 1500), said: String(t?.said || "").trim().slice(0, 600) }))
    .filter((t) => t.route);
  const now = conv.at(-1);
  const again = !now?.said ? "" : `
They're shaping this route with you, step by step. The conversation so far (each route you suggested, then what they said about it):
${conv.map((t, k) => `Route ${k + 1}: ${t.route}${t.said ? `\nThey said: "${t.said}"` : ""}`).join("\n")}

Now change Route ${conv.length} (the one on their screen) for what they just said. Start from it: keep its stays, nights, order, day trips and stops on the way, and change only what their newest message asks for, plus what follows from that (nights moving to keep the total, a neighbouring leg changing). Everything they said earlier still applies unless their newest message takes it back: a place they moved (to a day trip, to the way, out of the route) stays where they put it. Don't start over with a different route.
`;

  const must = (Array.isArray(req.mustSee) ? req.mustSee : []).slice(0, 40)
    .filter((m) => m && typeof m.name === "string" && m.name.trim())
    .map((m) => `- ${m.name.trim().slice(0, 120)}${Number.isFinite(m.lat) && Number.isFinite(m.lng) ? ` (at ${(+m.lat!).toFixed(2)}, ${(+m.lng!).toFixed(2)})` : ""}${m.how === "way" ? " [on the way: a stop on a drive between stays]" : m.how === "stay" ? " [from a stay]" : ""}`);
  const mustText = must.length ? `
Must-see places they've starred. Plan the route around them so every one gets visited, in one of three ways:
- a stay near it, when it's a highlight of a town worth staying in (Hohensalzburg Fortress: a stay in Salzburg);
- a day trip from a stay with 2+ nights, when it's within about 1.5 h of one (Burg Hohenwerfen: a day trip from that Salzburg stay; list it in that stay's "dayTrips");
- a stop on a drive between two stays, when it lies on the way (those marked [on the way] always; list it in "onTheWay").
Choose where the stays go so that this works, rather than dropping a place:
${must.join("\n")}
` : "";

  report({ type: "status", text: now?.said ? "Changing the route…" : "Thinking up a route…" });
  const prompt = `Plan the route of a trip: where to stay each night. (A separate step plans the days themselves later.)

Start: ${from.text}${req.startDate ? `, leaving on ${req.startDate}` : ""}. That's where they set off from, not a stay.
End: ${roundTrip ? `back at the start (a round trip)` : to.text}.
Length: ${days} days, so ${nights} nights away.
Travel: ${howText}; at most about ${maxHours} h of travel on a travel day.${month ? `
Season: they travel in ${month}. Suggest only what works then (no skiing or ski jumps outside winter, no closed mountain passes or huts in winter, no summer-only things out of season).` : ""}
${req.travelers ? `Travelers: ${req.travelers}. ` : ""}${req.interests ? `Interests: ${req.interests}.` : ""}${Number(req.budget) > 0 ? ` Budget: about ${Math.round(Number(req.budget))} ${String(req.currency || "EUR").slice(0, 3)} per day for everything, stays included.` : ""}
What they want: ${req.description || "a varied, scenic trip"}
${req.stays ? `Kind of places to stay: ${req.stays}` : ""}
${mustText}${again}
Choose the stays in travel order, between the start and the end (not the start or end themselves). Give them ${nights} nights in total. Make it a real, drivable (or travelable) route: each leg within about ${maxHours} h, and the last stay within a day of the end. Spend 2-3 nights where there is a lot to see (so there are full days for day trips), 1 night for a stop on the way. Favour the places and regions they asked for; "maybe" means include it if it fits well. People they want to visit (family, friends) get a stay where it fits the route. A town they name is the stay for its area: don't add another stay within about 40 km of it (or of any other stay).
Mind what beds cost: tiny, famous places with few and pricey places to stay (Hallstatt, for example) are usually better as a day trip from a nearby town that's easier on the budget (Hallstatt from Salzburg or Bad Ischl), unless they ask to stay there or their budget is generous.
The route must flow${roundTrip ? " as one loop" : " in one direction"}: each stay moves on from the last, and it never returns to a region it already left (no back and forth, no doubling back across a country). Group the stays by region and visit each region once.
Day trips: when they mention a place as a day trip ("a day trip to X", "a day in X"), or a place is small and close to a better base (a small country such as Liechtenstein, a single sight, a lake), don't make it a stay of its own: put it in "dayTrips" of the stay closest to it (one with 2+ nights). Only add day trips they asked for or that clearly fit what they want; most stays have none. Use real place names that a map can find (a town or a sight, with its country).
On the way: a place they ask to see or stop at on the way ("X on the way", "stop at X on the drive", "pass through X", "drop someone off at X"), in the description or in the chat, is never a stay and never a day trip: put it in "onTheWay" of the stay they arrive at after passing it, or in "onTheWayHome" when it's on the drive from the last stay to the end. Only for places they mention that way; leave these empty otherwise.
Reply with only JSON:
{"reasoning": "first, think it through in a few short sentences: ${now?.said ? "what you change in the route on their screen and why, " : ""}the regions, the order of the loop, where the day trips go, how the nights split", "title": "short trip name", "summary": "2-3 sentences on the route", "stays": [{"city": "town", "country": "country", "nights": 2, ${mode ? "" : `"travel": "car|train|bus|ferry|flight (how they get here from the previous place)", `}"why": "one short sentence: what's there and why stay", "dayTrips": [{"place": "town or sight, country", "why": "a few words"}], "onTheWay": [{"place": "town or sight, country", "why": "a few words"}]}], "onTheWayHome": [{"place": "town or sight, country", "why": "a few words"}]}`;

  const trips = (list: unknown, way: boolean): PlannedDayTrip[] => (Array.isArray(list) ? list : [])
    .map((t: any) => (typeof t === "string" ? { place: t, why: "" } : { place: String(t?.place || ""), why: String(t?.why || "") }))
    .map((t) => ({ place: t.place.trim().slice(0, 100), why: t.why.trim().slice(0, 160), ...(way ? { way } : {}) }))
    .filter((t) => t.place).slice(0, 3);
  const parsed = parseJsonLoose(await askModel(req.model, prompt, (n) => report({ type: "tokens", n }), {
    signal, onText: (reply, thinking) => { const text = reasoningSoFar(reply, thinking); if (text) report({ type: "reasoning", text }); },
    onRetry: (text) => report({ type: "status", text }),
  }));
  const stays: PlannedStay[] = (Array.isArray(parsed?.stays) ? parsed.stays : [])
    .filter((s: any) => s && typeof s.city === "string" && s.city.trim())
    .slice(0, 60)
    .map((s: any) => ({
      city: s.city.trim(), country: String(s.country || "").trim(), nights: Math.max(1, Math.round(Number(s.nights) || 1)),
      travel: mode || ((MODES as readonly string[]).includes(s.travel) ? s.travel : "car"), why: String(s.why || "").slice(0, 240),
      dayTrips: [...trips(s.dayTrips, false), ...trips(s.onTheWay, true)],
    }));
  if (!stays.length) throw new Error("The model didn't come back with a route. Try again, or describe the trip a bit more.");
  // Stops on the drive home: placed on the leg they fit best (that's the last one when they're on the way home).
  stays.at(-1)!.dayTrips = [...(stays.at(-1)!.dayTrips || []), ...trips(parsed?.onTheWayHome, true).map((t) => ({ ...t, home: true }))];
  fitNights(stays, nights);

  // Where everything is, then the real road distance and time of each leg travelled by road.
  for (const [k, s] of stays.entries()) {
    report({ type: "status", text: `Checking where the stays are (${k + 1} of ${stays.length})…` });
    const c = await locate(s.country ? `${s.city}, ${s.country}` : s.city);
    if (c) { s.lat = c[0]; s.lng = c[1]; }
  }
  const before = stays.length;
  mergeClose(stays, req.description || "");
  if (stays.length < before) report({ type: "status", text: "Merged stays that were right next to each other" });
  const places = [{ city: req.start, country: "" }, ...stays, { city: end, country: "" }];
  const coords: (LatLng | null)[] = [from.at, ...stays.map((s): LatLng | null => (s.lat != null ? [s.lat, s.lng!] : null)), to.at];
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
  // Each day trip from the stay it's really closest to, or as a stop on the way. A name the map places far from the
  // stay it was listed on is the wrong place (a "Swiss valley" in Wales): try simpler forms of the name, else leave it
  // off the map (the itinerary planner still gets the name).
  const all = stays.flatMap((s) => (s.dayTrips || []).map((t) => ({ t, s })));
  for (const [k, { t, s }] of all.entries()) {
    report({ type: "status", text: `Checking the day trips (${k + 1} of ${all.length})…` });
    const ref: LatLng | null = s.lat != null ? [s.lat, s.lng!] : null;
    for (const q of nameForms(t.place)) {
      const c = await locate(q);
      if (c && (!ref || km(c, ref) <= (t.way ? 400 : 200))) { t.lat = c[0]; t.lng = c[1]; t.place = q; break; }
    }
  }
  // What they've said counts as naming a place: the description and their replies in the chat.
  const said = [req.description || "", ...conv.map((t) => t.said)].join("\n");
  const wayAt = (Array.isArray(req.mustSee) ? req.mustSee : [])
    .filter((m) => m?.how === "way" && Number.isFinite(m.lat) && Number.isFinite(m.lng)).map((m): LatLng => [+m.lat!, +m.lng!]);
  const via = coords.every(Boolean) ? placeTrips(coords as LatLng[], stays, said, wayAt) : new Map<number, WayStop[]>();
  const legs: PlannedLeg[] = [];
  for (let k = 1; k < places.length; k++) {
    const travel = k < places.length - 1 ? stays[k - 1].travel : (mode || stays.at(-1)!.travel);
    const leg: PlannedLeg = { from: places[k - 1].city, to: places[k].city, tooLong: false, ...(via.get(k - 1) ? { via: via.get(k - 1) } : {}) };
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
