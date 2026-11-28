// Routes between stops along real streets and roads, fetched through the server (which queues and caches them).
import type { Day, ItineraryItem, LatLng, Route, RouteMode } from "../../../shared/types";
import { api } from "../core/dom";
import { type ByTitle, itemLoc } from "../geo/item-loc";
import { distKm, stayLoc, stayOn } from "../geo/locate";
import { state } from "../core/state";
import { byWho, chosenMode, cleanStop, legGroup, modeOf, onWayOf, splitGroup, stopCompany, transferEnds } from "../trip/modes";
import { setMapStatus } from "./status";
import { DRIVE_KM, arrivalStay, isTransfer, journeyOf, onMap, ownsJourney, viaStops } from "./travel-day";

/** Route key -> route, or null if there is none. */
export const routes: Record<string, Route | null> = {};
export const routeKey = (mode: RouteMode, a: LatLng, b: LatLng) => `${mode}:${a[0].toFixed(5)},${a[1].toFixed(5)}>${b[0].toFixed(5)},${b[1].toFixed(5)}`;

/** How a leg is drawn: along paths, roads, railways, boat routes or lift lines, as a flight's arc, or as a straight line
 *  (no route, short rail hops). */
export type LegMode = RouteMode | "flight" | "straight";
/** group: the split group whose leg it is (from or to one of its stops), "" when everyone travels together. part: which
 *  piece of a leg that goes through other places (0 first), when it does. */
/** bus: a bus leg (mode "transit"): drawn along its line, or along the road when the router has no such line. */
export interface Leg { xi: number; fromXi: number; mode: LegMode; from: LatLng; to: LatLng; group?: string; part?: number; manual?: boolean; when?: string; bus?: boolean }

/** The routed path for a leg: a route, null (none exists or not routable), or undefined (still being routed). A bus with
 *  no line found goes by road. */
export function legRoute(leg: { mode: LegMode; from: LatLng; to: LatLng; bus?: boolean }) {
  if (leg.mode === "straight" || leg.mode === "flight") return null;
  const r = routes[routeKey(leg.mode, leg.from, leg.to)];
  return r === null && leg.bus ? routes[routeKey("car", leg.from, leg.to)] : r;
}

/** A flight's line: a gentle arc (bowing to the left of the way it flies), so it reads as a flight, not a road. */
export function flightArc(a: LatLng, b: LatLng, n = 32): LatLng[] {
  const dy = b[0] - a[0], dx = b[1] - a[1], bow = 0.18;
  const ctrl: LatLng = [(a[0] + b[0]) / 2 + dx * bow, (a[1] + b[1]) / 2 - dy * bow];
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = k / n, u = 1 - t;
    return [u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1]] as LatLng;
  });
}

// From the stop's transport text ("Walk, 5 min", "Bus 710", "Railjet to Munich", "Boat to Vitznau", "Gondola down to
// Kriens"), else by distance. Trains of some length and cog railways follow the tracks, boats their route, gondolas and
// cable cars their line through the middle stations, trams, metros and bus lines theirs, bikes the cycle paths; flights
// are arcs, and short rail hops stay straight lines.
const RAIL = /\b(train|trains|rail|railjet|rjx?|ice|ic|ec|intercity|regional|regio|s-?bahn)\b/i;
const FLIGHT = /\b(flight|flights|fly|flying|plane|airline|airlines)\b/i;
const BIKE = /\b(bike|bikes|bicycle|cycling|cycle|e-?bike|velo|v[ée]lo|fahrrad|rad)\b/i;
// Town transport by its line: a tram or a metro; and buses, along their line when the router knows it (else the road).
const TRANSIT_LINE = /\b(trams?|streetcar|light rail|metro|subway|u-?bahn|underground|tube|line \d+)\b/i;
const BUS = /\b(bus|buses|postbus|postauto|coach|flixbus)\b/i;
export const BOAT = /\b(ferry|ferries|boat|boats|ship|steamer|steamboat|paddle steamer|lake cruise|cruise|vaporetto|water ?bus|water taxi|schiff|dampfer|bateau|traghetto)\b/i;
const LIFT = /\b(gondolas?|cable ?cars?|cableway|aerial (?:tram|tramway|cableway|lift)|ropeway|chair ?lifts?|t[ée]l[ée]ph[ée]rique|t[ée]l[ée]cabine|seilbahn|luftseilbahn|gondelbahn|sesselbahn|sessellift|funiculars?|standseilbahn|funivia|cabinovia|seggiovia|funicolare|dragon ride)\b/i;
const COG = /\b(cog ?wheel|cog railway|cog train|rack railway|zahnradbahn|cremagliera)\b/i;
const ROAD = /\b(bus|coach|taxi|uber|car|drive|driving|shuttle|transfer)\b/i;
const TRAIN = /\b(train|trains|rail|railjet|rjx?|ice|ic|ec|intercity|regional|regio|s-?bahn|shinkansen|limited express|jr|tgv|frecciarossa|italo|ave)\b/i;
export const FOOT = /\b(walk|walking|on foot|stroll|hike|zu fu)/i;
// A real hike can be long; "walk" usually means the last bit from the car park or the station.
const HIKE = /\b(hike|hiking|trail|trek|wander)/i;
const walkable = (t: string, km: number) => km < 2.5 || (HIKE.test(t) && km < 15);

function legMode(x: ItineraryItem, a: LatLng, b: LatLng, dayMode = ""): LegMode | null {
  // A transfer's name says how too: "Fräkmüntegg → Kriens (gondola)".
  const t = [x.transport, isTransfer(x) ? x.place : ""].filter(Boolean).join(" "), km = distKm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
  if (km < 0.03) return null;
  const m = chosenMode(x) || (km > 2 && !(FOOT.test(t) && walkable(t, km)) ? dayMode : "");
  if (m === "bus") return km > 0.3 ? "transit" : "foot";
  if (m === "car") return "car";
  if (m === "train") return km > 5 || (COG.test(t) && km > 0.5) ? "train" : TRANSIT_LINE.test(t) && km > 0.3 ? "transit" : "straight";
  if (m === "ferry") return km > 0.5 ? "ferry" : "straight";
  if (m === "flight") return "flight";
  if (m === "bike") return "bike";
  if (m) return "straight";
  // "Boat to Vitznau (or train via Arth-Goldau)", "gondola down, then Bus 1": whichever it names first.
  const first = ([[BOAT, "ferry"], [LIFT, "lift"], [COG, "cog"], [TRAIN, "train"], [FLIGHT, "flight"], [TRANSIT_LINE, "transit"], [BUS, "transit"], [BIKE, "bike"]] as const)
    .map(([re, k]) => ({ at: t.search(re), k })).filter((c) => c.at >= 0).sort((p, q) => p.at - q.at)[0]?.k;
  if (first === "ferry" && km > 0.5) return "ferry";
  if (first === "lift" && km > 0.1) return "lift";
  if (first === "cog" && km > 0.5) return "train";
  if (first === "train" && km > 5) return "train";
  if (first === "flight" && km > 50) return "flight";
  if (first === "transit" && km > 0.3) return "transit";
  if (first === "bike" && km > 0.3) return "bike";
  if (RAIL.test(t) && km > 2) return "straight";
  if (FOOT.test(t) && walkable(t, km)) return "foot";
  if (ROAD.test(t)) return "car";
  if (km < 1.5) return "foot";
  // Nothing said: as they get around (by public transport: town transport, a train further out), else by road.
  // Car between stays, public transport in town: short hops by transit, longer ones by road.
  if (state.getAround === "mixed") return km < 30 ? "transit" : "car";
  if (gettingAround() === "transit") return km > 20 ? (km < 300 ? "train" : "straight") : "transit";
  return km < 80 ? "car" : "straight";
}

const TRANSIT_WORDS = /\b(train|trains|metro|subway|bus|buses|tram|trams|jr|shinkansen|station|u-?bahn|s-?bahn|line|rail|railway|ferry|boat|taxi)\b/gi;
const CAR_WORDS = /\b(drive|drives|driving|car|parking|park at|motorway|autobahn|highway|toll)\b/gi;
let aroundOf: { key: string; around: "transit" | "car" } | null = null;
/**
 * How they get around: as set (Travelers & style), else what the plan says most, public transport or the car (an older
 * plan with vague transport, "15 min", was drawn by road even for a trip without a car). Worked out once per plan.
 */
export function gettingAround(): "transit" | "car" {
  if (state.getAround === "transit" || state.getAround === "car") return state.getAround;
  const items = state.itinerary?.days.flatMap((d) => d.items) || [];
  const text = items.map((x) => `${x.transport || ""} ${x.kind === "transfer" ? x.place : ""}`).join(" ");
  const key = `${items.length}|${text.length}|${state.stays.map((s) => s.travel || "").join(",")}`;
  if (aroundOf?.key === key) return aroundOf.around;
  const transit = text.match(TRANSIT_WORDS)?.length || 0;
  const car = (text.match(CAR_WORDS)?.length || 0) + state.stays.filter((s) => s.travel === "car").length * 3;
  aroundOf = { key, around: transit > car ? "transit" : "car" };
  return aroundOf.around;
}

/** First words of stop names that aren't places ("Dinner at …", "Walk along …"). */
const NOT_VIA = /^(lunch|dinner|breakfast|brunch|coffee|drinks|walk|stroll|hike|hotel|check|back|return|free|visit|boat|ferry|train|bus|cruise|tour|old|the|day|evening|morning|afternoon|sunset|arrive|arrival|depart|departure)$/i;
const kmBetween = (a: LatLng, b: LatLng) => distKm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The places a stop's transport text goes through on the way ("Cog railway down to Vitznau, then the boat back to
 * Lucerne"): the day's other stops (also by the first word of their name, "Vitznau" for "Vitznau pier") and the towns
 * they stay in, where the text names them. Not the leg's own ends or a town right by them, and not a detour.
 */
function viaPoints(d: Day, byTitle: ByTitle, text: string, ends: number[], from: LatLng, to: LatLng) {
  if (!text) return [];
  const cands: { name: string; at: LatLng }[] = [];
  d.items.forEach((y, yi) => {
    if (ends.includes(yi) || !onMap(y, d)) return;
    const loc = itemLoc(y, d, byTitle);
    if (!loc) return;
    // A transfer's point is where it arrives.
    const name = transferEnds(y)?.[1] || cleanStop(y.place), first = name.split(/\s+/)[0];
    cands.push(...[name, ...(NOT_VIA.test(first) ? [] : [first])].filter((n) => n.length >= 4 && /^\p{Lu}/u.test(n)).map((n) => ({ name: n, at: [loc.lat, loc.lng] as LatLng })));
  });
  for (const s of state.stays) {
    const l = stayLoc(s);
    if (l && s.city) cands.push({ name: s.city.split(",")[0].trim(), at: [l.lat, l.lng] });
  }
  const direct = kmBetween(from, to);
  const found: { at: LatLng; start: number; end: number }[] = [];
  for (const c of cands) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${escRe(c.name)}(?![\\p{L}\\p{N}])`, "iu").exec(text);
    if (!m || kmBetween(c.at, from) < 1.5 || kmBetween(c.at, to) < 1.5) continue;
    if (kmBetween(from, c.at) + kmBetween(c.at, to) > direct * 2.5 + 5) continue;
    found.push({ at: c.at, start: m.index, end: m.index + m[0].length });
  }
  // In the order the text names them; where names overlap ("Vitznau pier" and "Vitznau") the longer, once per place.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: typeof found = [];
  for (const f of found) {
    const prev = out[out.length - 1];
    if (prev && (f.start < prev.end || kmBetween(f.at, prev.at) < 0.3)) continue;
    out.push(f);
  }
  return out;
}

/** The legs of a day: from each stop to the next one with a location (each split group follows its own path). A leg
 *  whose transport text goes through other places of the day comes in parts, each by its own mode ("cog railway down
 *  to Vitznau, then the boat back": rail to Vitznau, then boat). */
export function dayLegs(d: Day, byTitle: ByTitle): Leg[] {
  // Transfers are movements, not places; on a travel day the long legs are the drive between the stays, drawn as one
  // line with the stays (see travel-day.ts), and other legs follow the mode picked for that drive.
  const pts = d.items.map((x, xi) => ({ x, xi, loc: onMap(x, d) ? itemLoc(x, d, byTitle) : null })).filter((p) => p.loc);
  const arrive = arrivalStay(d);
  // A travel day that spells out its own journey (its rides are stops) is drawn leg by leg, from the last stay's hotel;
  // otherwise the stays' own line is the journey, and the day's long legs aren't drawn again on top of it.
  const journey = journeyOf(d), owns = ownsJourney(d);
  const drive = !owns && arrive > 0 && !!stayLoc(state.stays[arrive - 1]) && !!stayLoc(state.stays[arrive]);
  // Between two stops on the way, the drive line is the route, however short.
  const via = new Set(drive ? viaStops(arrive, byTitle).map((v) => v.xi) : []);
  const dayMode = arrive > 0 ? state.stays[arrive].travel || "" : "";
  const groups = [...new Set(d.items.map(splitGroup).filter(Boolean))];
  // By name, each person's own way (legs people share are drawn once).
  const names = byWho(d.items) ? [...new Set(d.items.flatMap(stopCompany))] : [];
  const paths = names.length ? names.map((n) => pts.filter((p) => { const w = stopCompany(p.x); return !w.length || w.includes(n); }))
    : groups.length ? groups.map((g) => pts.filter((p) => onWayOf(d.items, p.x, g))) : [pts];
  // Keyed by both ends: two groups heading to the same stop (the dinner where they meet again) are two legs.
  const legs = new Map<string, Leg>();
  type Pt = { x: ItineraryItem | null; xi: number; loc: { lat: number; lng: number } };
  /** The leg (or its parts) from one point of the day to the next; `a.xi` is -1 for where they slept. */
  const connect = (a: Pt, b: Pt) => {
    const from: LatLng = [a.loc.lat, a.loc.lng], to: LatLng = [b.loc.lat, b.loc.lng], x = b.x!;
    // A transfer between the two stops ("Hiroshima → Shin-Osaka (train)") says how this leg goes.
    const group = legGroup(d.items, a.x ? splitGroup(a.x) : "", splitGroup(x));
    const between = d.items.slice(a.xi + 1, b.xi).filter((y) => isTransfer(y) && onWayOf(d.items, y, group));
    const key = `${a.xi}>${b.xi}`, text = String(x.transport || "");
    // When it leaves: the stop before's time (else this one's), on the day, so boats and trains are looked up for then.
    const hhmm = [a.x?.time, x.time].map((t) => /^(\d{1,2}):(\d{2})/.exec(t || "")).find(Boolean);
    const when = /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? `${d.date}T${hhmm ? `${hhmm[1].padStart(2, "0")}:${hhmm[2]}` : "09:00"}` : undefined;
    const base = { xi: b.xi, fromXi: a.xi, group, when };
    // A transfer they placed on the map is this leg itself: its own mode ("Vitznau → Lucerne (SGV boat)") says how.
    const byTransfer = (isTransfer(x) ? chosenMode(x) || modeOf(x) : "") || between.map((y) => chosenMode(y) || modeOf(y)).find(Boolean) || "";
    // Set by hand ("How you get here"): exactly that, through the places they gave.
    if (x.leg?.modes?.length) {
      const pts: LatLng[] = [from, ...(x.leg.via || []).map((v): LatLng => [v.lat, v.lng]), to];
      pts.slice(1).forEach((p, k) => {
        // "Bus" is town transport along its line (else the road).
        const choice = x.leg!.modes[k] || "straight";
        if (kmBetween(pts[k], p) >= 0.03) legs.set(`${key}#${k}`, { ...base, mode: choice === "bus" ? "transit" : choice, ...(choice === "bus" ? { bus: true } : {}), from: pts[k], to: p, part: k, manual: true });
      });
      return;
    }
    const vias = byTransfer ? [] : viaPoints(d, byTitle, text, [a.xi, b.xi], from, to);
    if (vias.length) {
      // Each part by what the text says between the places it names; a part it says nothing about is a straight
      // line (not a road the text never mentions).
      const pts = [from, ...vias.map((v) => v.at), to];
      pts.slice(1).forEach((p, k) => {
        const part = text.slice(k ? vias[k - 1].end : 0, k < vias.length ? vias[k].start : text.length);
        let mode = legMode({ ...x, transport: part }, pts[k], p, dayMode);
        if (mode === "car" && !ROAD.test(part)) mode = "straight";
        if (mode) legs.set(`${key}#${k}`, { ...base, mode, from: pts[k], to: p, part: k, ...(mode === "transit" && BUS.test(part) ? { bus: true } : {}) });
      });
      return;
    }
    const mode = legMode(x, from, to, byTransfer || dayMode);
    // A bus (named in the text, or the transfer's mode): along its line, else the road.
    const bus = mode === "transit" && (byTransfer === "bus" || BUS.test(`${text} ${isTransfer(x) ? x.place : ""}`));
    if (mode) legs.set(key, { ...base, mode, from, to, ...(bus ? { bus: true } : {}) });
  };
  // Where they slept: the day starts there. Drawn when the first stop is out of town (the boat to Alpnachstad), not
  // for a café round the corner; a travel day's start is the drive between the stays instead.
  const stay = arrive > 0 ? (owns ? state.stays[arrive - 1] : undefined) : stayOn(d), home = stay ? stayLoc(stay) : undefined;
  const away = owns ? stayLoc(state.stays[arrive]) : undefined, lastRide = owns ? Math.max(...journey!.runs.flatMap((r) => r.items).filter((i) => isTransfer(d.items[i]))) : -1;
  for (const path of paths) {
    const first = path[0];
    // A journey starts at the hotel they leave, however close the first stop.
    if (home && first && (owns || kmBetween([home.lat, home.lng], [first.loc!.lat, first.loc!.lng]) > 1.5)) connect({ x: null, xi: -1, loc: home }, first as Pt);
    // A journey with no stop on the map at all: from the hotel they leave straight to the new one, by its rides.
    if (owns && home && away && !first) {
      // By the journey's main ride (the train, not the taxi at the end).
      const rides = journey!.runs.flatMap((r) => r.items).filter((i) => isTransfer(d.items[i]));
      const main = rides.find((i) => ["train", "flight", "ferry"].includes(chosenMode(d.items[i]) || modeOf(d.items[i]))) ?? lastRide;
      connect({ x: null, xi: -1, loc: home }, { x: d.items[main], xi: lastRide, loc: away });
    }
    for (let i = 1; i < path.length; i++) {
      const from: LatLng = [path[i - 1].loc!.lat, path[i - 1].loc!.lng], to: LatLng = [path[i].loc!.lat, path[i].loc!.lng];
      if (drive && (distKm({ lat: from[0], lng: from[1] }, { lat: to[0], lng: to[1] }) > DRIVE_KM || (via.has(path[i - 1].xi) && via.has(path[i].xi)))) continue;
      connect(path[i - 1] as Pt, path[i] as Pt);
    }
    // Rides after the last stop on the map (the taxi up to the hotel, with no check-in stop): on to the new stay.
    const last = path[path.length - 1];
    if (owns && away && last && lastRide > last.xi) connect(last as Pt, { x: d.items[lastRide], xi: lastRide, loc: away });
  }
  return [...legs.values()];
}

/** Where a leg starts, by name: the stop before, or (for the day's first leg) where they slept. */
export function legStart(d: Day, leg: Leg) {
  if (leg.fromXi >= 0) return d.items[leg.fromXi]?.place || "";
  const s = stayOn(d);
  return s ? s.hotel || s.city.split(",")[0] : "where you sleep";
}

const wanted = new Map<string, { mode: RouteMode; from: LatLng; to: LatLng; when?: string }>();
let timer: number | null = null, redraw: number | undefined;
let onRouted: () => void = () => {};
/** What to do when new routes arrive (redraw the map and leg info). */
export const setOnRouted = (fn: () => void) => { onRouted = fn; };

export function requestRoutes(legs: { mode: LegMode; from: LatLng; to: LatLng; when?: string; bus?: boolean }[]) {
  for (const l of legs) {
    if (l.mode === "straight" || l.mode === "flight") continue;
    const k = routeKey(l.mode, l.from, l.to);
    if (!(k in routes)) wanted.set(k, { mode: l.mode, from: l.from, to: l.to, ...(l.when ? { when: l.when } : {}) });
    // A bus the router knows no line for: the road instead.
    else if (routes[k] === null && l.bus) {
      const c = routeKey("car", l.from, l.to);
      if (!(c in routes)) wanted.set(c, { mode: "car", from: l.from, to: l.to });
    }
  }
  if (wanted.size && !timer) timer = window.setTimeout(poll, 300);
}

async function poll() {
  timer = null;
  if (!wanted.size) return;
  try {
    const { routes: got, pending } = await api<{ routes: Record<string, Route | null>; pending: number }>("/api/routes", {
      method: "POST", body: JSON.stringify({ legs: [...wanted.values()] }),
    });
    Object.assign(routes, got);
    for (const k of Object.keys(got)) wanted.delete(k);
    if (Object.keys(got).length) { clearTimeout(redraw); redraw = window.setTimeout(onRouted, 200); }
    if (pending) { setMapStatus(`Routing ${pending} leg${pending > 1 ? "s" : ""}…`); timer = window.setTimeout(poll, 2500); }
    else setMapStatus("");
  } catch { timer = window.setTimeout(poll, 5000); }
}
