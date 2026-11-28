// The checked planner (Settings → Plan style → Planner → Checked, experimental). Works with every model through
// askModel (ask.ts), which enforces the JSON schemas where the provider can:
//   0. model: before any planner runs (routes/itinerary.ts), their interests, wishes and notes are read into diets,
//             allergies and the kinds of place they asked for (trip/prefs.ts), so the place lists suit them and a wish
//             that no stop meets is sent back as a problem (validate.ts)
//   1. code:  the trip's frame (frames.ts): dates, travel/full days, where they sleep, routed drives through the stops
//             on the way, holidays where they actually are; research lines dated outside their stay are marked
//   2. model: the outline: which day gets which places (short answer, one request)
//   3. model: the days in detail, a few at a time, with a shared ledger of what earlier days already use. The model
//             names places, times and how to get there; it gives no coordinates and writes no drives as stops.
//   4. code:  where every stop is (resolve.ts: saved places, OpenStreetMap, the stay, lookups by name), the real time
//             between stops that are far apart (routing service), then the checks (validate.ts)
//   5. model: only the days with problems go back, with the problems; a rewrite is kept only if it's better
//   6. code:  assembly: the drives between towns written into the first stop there with the routed time, costs added
//             up, local currency, holidays and events filtered, must-sees left out reported
// The page's own fix round (closed places, repeats it finds) comes back here too (fixChecked), so one set of rules
// applies throughout. Re-planning a day, changes and revisions still go through the usual planner (routes/itinerary.ts).
import type { Day, HolidayOrEvent, ItineraryItem, Place, PlanChecks, RunResult } from "../../../shared/types";
import type { GeoHit } from "../../../shared/geo";
import { km } from "../../../shared/route";
import { DAY_SIZE, paceOf } from "../../../shared/planner";
import { errMsg } from "../../config";
import { geoCache, geocodeOne, geoKey, locateTown } from "../../geo/geocode";
import { waitForRoute } from "../../geo/routing";
import { researchWith } from "../../research/research-model";
import type { NearbyPlace } from "../../trip/nearby";
import { askModel, TruncatedError } from "../ask";
import { parseCloudId } from "../cloud-models";
import { placesByStay, outlineProblems } from "../local-steps";
import { parseModelId, serverName } from "../local-models";
import { addMissingMustSees, normalizeItinerary, parseJsonLoose } from "../output";
import type { OnEvent, Trip } from "../types";
import { annotateResearch, buildFrames, type Frame, localCurrency, routeFrames, type RouteFn, travelLoad, TOO_LONG_HOURS } from "./frames";
import { batchPrompt, outlinePrompt, repairPrompt } from "./prompts";
import { type GeoFn, type Located, resolveDays, spotKey } from "./resolve";
import { CHECKED_VERSION, daysSchema, dropNulls, KINDS, OUTLINE_SCHEMA, type SchemaOptions } from "./schema";
import { clock, doers, hm, isCheckIn, isDriveTransfer, isHotelStop, isMealStop, isRide, isTransfer, lc, minutes, namedMeal, norm, short, transferEnds } from "./text";
import { type CheckContext, defaultMinutes, dropSameDayRepeats, dropStandIns, filterEvents, foldTransfers, isSubstantive, type Issue, names, quickFixHours, quickFixMeals, score, shiftTimes, tidyDays, unverifiedTimes, validatePlan, visits } from "./validate";

/** Tunable limits (code-level settings of the experimental planner). */
export const CHECKED_LIMITS = {
  /** Days written per request: local models get fewer (smaller prompts, less to keep in mind). */
  batchLocal: 2, batchCloud: 4,
  /** Rounds of sending broken days back, and days per repair request. */
  repairRounds: 2, repairBatch: 3,
  /** How long one answer may take. */
  timeoutMs: 15 * 60_000,
  /** Stops at least this far apart get their time between them from the routing service. */
  routeFromKm: 15,
};

interface OutlineDay { date: string; title: string; theme: string; places: string[] }
interface Outline {
  destination: string; summary: string; planningNotes: string; tips: string[]; days: OutlineDay[];
  unused: { place: string; reason: string }[]; events: { date: string; name: string; where: string; impact: string }[];
}
type Plans = Map<string, { title: string; theme: string; places: string[] }>;

const at = (p?: { lat?: number; lng?: number } | null): p is { lat: number; lng: number } => typeof p?.lat === "number" && typeof p?.lng === "number";
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const ROAD = new Set(["car", "bus", "bike", ""]);

/** Which model and how it's paid for, as the result names it. */
function engineOf(id: string): { engine: string; billing: RunResult["billing"]; local: boolean } {
  if (id.startsWith("local|")) { const { kind, base, model } = parseModelId(id); return { engine: `${model} (${serverName(kind, base)}, checked planner)`, billing: "local", local: true }; }
  if (id.startsWith("api|")) { const { provider, model } = parseCloudId(id); return { engine: `${model} via ${provider} API, checked planner`, billing: "api", local: false }; }
  return { engine: `${id && id !== "default" ? id : "Claude"} via Claude Code, checked planner`, billing: "plan", local: false };
}

/** A real road route, from the routing service (cached on disk). */
const roadRoute: RouteFn = async (a, b) => {
  if (!at(a) || !at(b)) return undefined;
  const r = await waitForRoute("car", [a.lat, a.lng], [b.lat, b.lng], 25000).catch(() => undefined);
  return r ? { hours: r.t / 3600, km: Math.round(r.d / 1000) } : r;
};

/** Lookups through the same disk cache the page uses (so what's found here is known to the map at once). */
export const geoCached: GeoFn = async (q, cc, near, kind) => {
  if (kind === "town") return locateTown(q, cc);
  const key = geoKey(q, cc, near, true);
  if (key in geoCache.data) { const v = geoCache.data[key]; return v && typeof v === "object" && "lat" in v ? (v as GeoHit) : null; }
  const hit = await geocodeOne(q, cc, near, true).catch(() => null);
  geoCache.data[key] = hit; geoCache.save();
  return hit;
};

/** A day from a model's answer, coerced into the app's shape (strict schemas send nulls; small models stray). The
 *  model's idea of where a stop is (if it gave one anyway) is dropped: resolve.ts finds that out. */
export function coerceDay(raw: any): Day | null {
  if (!raw || typeof raw !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(String(raw.date))) return null;
  const d = dropNulls(raw);
  const items: ItineraryItem[] = (Array.isArray(d.items) ? d.items : []).filter((x: any) => x && typeof x.place === "string" && x.place.trim()).map((x: any) => {
    const item: ItineraryItem = { ...x, time: String(x.time ?? "").trim(), place: String(x.place).trim(), description: String(x.description ?? "") };
    if (!KINDS.includes(item.kind as any)) item.kind = "other";
    if (item.cost != null) item.cost = Number(item.cost);
    if (item.durationMinutes != null) item.durationMinutes = Number(item.durationMinutes);
    if (!item.pinned && !item.fixed) { delete item.lat; delete item.lng; }
    delete item.where; delete (item as any).website;
    return item;
  });
  return { date: String(d.date), city: String(d.city ?? ""), title: String(d.title ?? d.city ?? ""), notes: d.notes ? String(d.notes) : undefined, estimatedCost: 0, items };
}

/** The days of an answer, or null when it isn't one. */
function daysOf(text: string): Day[] | null {
  let o: any;
  try { o = parseJsonLoose(text); } catch { return null; }
  if (!o || !Array.isArray(o.days)) return null;
  return o.days.map(coerceDay).filter((d: Day | null): d is Day => !!d);
}

/** Groups of consecutive days to write together: the days of one stay, at most `size` at a time. */
export function batchFrames(frames: Frame[], size: number): Frame[][] {
  const out: Frame[][] = [];
  let cur: Frame[] = [], key = -2;
  for (const f of frames) {
    const k = f.sleep ? f.sleep.idx : key; // the last day goes with the stay it leaves
    if (cur.length && (cur.length >= size || k !== key)) { out.push(cur); cur = []; }
    cur.push(f); key = k;
  }
  if (cur.length) out.push(cur);
  return out;
}

const schemaOptions = (trip: Trip): SchemaOptions => ({
  splits: Object.values(trip.mustSeeWho || {}).some((n) => n < trip.travelers) || trip.stays.some((s) => (s.dayTrips || []).some((d) => d.people && d.people < trip.travelers)),
  named: !!trip.people?.length,
});

/** The stops of a day in the order each group does them (everyone's stops belong to every subgroup's timeline). */
function timelines(items: ItineraryItem[]): number[][] {
  const lines = new Map<string, number[]>();
  items.forEach((x, i) => { for (const g of x.who?.length || x.group ? [doers(x)] : [""]) lines.set(g, [...(lines.get(g) || []), i]); });
  const together = lines.get("") || [];
  for (const [g, idx] of lines) if (g) lines.set(g, [...idx, ...together].sort((a, b) => a - b));
  return [...lines.values()];
}

/** Minutes by road between stops that are far apart (by `${date}#${index}` of the stop reached), from the routing service. */
export async function travelNeeds(days: Day[], located: Located, route: RouteFn, into: Record<string, number> = {}, wakeOf: (date: string) => { lat: number; lng: number; name: string } | null = () => null) {
  for (const d of days) for (const line of timelines(d.items)) {
    // The last stop of the timeline whose place is known; before any, where they woke up.
    let anchor: { lat: number; lng: number; name: string } | null = wakeOf(d.date);
    for (const i of line) {
      const x = d.items[i], s = located.get(spotKey(d.date, i));
      if (!s || isDriveTransfer(x)) continue;
      if (anchor && !isRide(x) && !/\b(ferry|boat|catamaran|flight|plane|train|rail)\b/i.test(x.transport || "")) {
        if (km(anchor, s) >= CHECKED_LIMITS.routeFromKm) {
          const r = await route(anchor, { ...s, name: x.place });
          if (r) into[spotKey(d.date, i)] = r.hours * 60;
        }
      }
      anchor = { ...s, name: x.place };
    }
  }
  return into;
}

/** Where they wake up on a date: the stay slept at the night before, else the stay the day's first leg leaves. */
export function wakeStay(frames: Frame[], stays: Trip["stays"], date: string) {
  const i = frames.findIndex((f) => f.date === date);
  if (i < 0) return null;
  const idx = i > 0 && frames[i - 1].sleep ? frames[i - 1].sleep!.idx : frames[i].legs[0]?.fromIdx;
  const s = idx != null ? stays[idx] : null;
  return s && at(s) ? { lat: s.lat, lng: s.lng, name: short(s.city) } : null;
}

interface Setup { trip: Trip; places: Place[]; frames: Frame[]; route: RouteFn; geo: GeoFn }

/** The saved places without the ones that are a stay (their home address picked on the map, a hotel): accommodation, not stops. */
export function withoutStays(trip: Pick<Trip, "stays">, places: Place[]) {
  return places.filter((p) => !trip.stays.some((s) => lc(short(s.city)) === lc(short(p.title)) || (at(s) && at(p) && !(Number(s.nights) > 0) && km(s, p) < 0.3)));
}

/** The context the checks run in: the frame, where every stop of these days is, and the routed time between far-apart stops. */
export async function contextFor({ trip, places, frames, route, geo }: Setup, days: Day[]): Promise<{ ctx: CheckContext; notes: string[] }> {
  const ctx: CheckContext = {
    frames, stays: trip.stays, mustSee: trip.mustSee || [], skip: trip.skip || [], saved: places, pace: paceOf(trip.pace), getAround: trip.getAround || "",
    dailyBudget: trip.budgetPer === "person" ? trip.dailyBudget * (Number(trip.travelers) || 1) : trip.dailyBudget,
    known: [...(trip.trains || []), trip.researchNotes || "", trip.notes || "", ...(trip.bookings || []).map((b) => `${b.name} ${b.from || ""} ${b.to || ""}`)].join("\n"),
    located: new Map(), hops: {}, wants: trip.prefs?.wants || [], wished: trip.nearby || [],
  };
  const notes = await refresh({ trip, places, frames, route, geo }, ctx, days);
  return { ctx, notes };
}

const countriesOf = (trip: Trip) => [...new Set(trip.stays.map((s) => lc(s.cc || "")).filter(Boolean))].join(",");

/** Locates these days' stops again (after a rewrite or a fold) and their routed hops; the other days' stay as they are. */
async function refresh({ trip, places, frames, route, geo }: Setup, ctx: CheckContext, days: Day[]) {
  const dates = new Set(days.map((d) => d.date));
  for (const k of [...ctx.located!.keys()]) if (dates.has(k.split("#")[0])) ctx.located!.delete(k);
  for (const k of Object.keys(ctx.hops!)) if (dates.has(k.split("#")[0])) delete ctx.hops![k];
  const { notes } = await resolveDays(days, { frames, stays: trip.stays, saved: places, nearby: trip.nearby || [], countries: countriesOf(trip), geo }, ctx.located!);
  await travelNeeds(days, ctx.located!, route, ctx.hops!, (date) => wakeStay(frames, trip.stays, date));
  return notes;
}

/**
 * The drives between towns, from the frame: written into the first stop in each town ("Drive from Vienna, 1 h 05 min
 * (80 km)", keeping the model's parking note), or, when nothing follows the last drive of the day (the drive home), a
 * transfer stop at the end. The day's "city" names the towns it goes through, for the page.
 */
export function finishDay(d: Day, f: Frame, trip: Trip, located: Located): string[] {
  const notes: string[] = [];
  const spot = (i: number) => located.get(spotKey(d.date, i));
  const stayPt = (i: number) => ({ name: trip.stays[i].city, lat: trip.stays[i].lat, lng: trip.stays[i].lng });
  const towns = f.legs.flatMap((l) => [short(l.from), ...l.stops.map((s) => short(s.name)), short(l.to)]);
  d.city = [...new Set(f.kind === "full" && f.sleep ? [short(f.sleep.city)] : towns.length ? towns : f.sleep ? [short(f.sleep.city)] : [])].join(" / ") || d.city;
  for (const leg of f.legs) {
    const road = ROAD.has(leg.mode);
    const pts = [stayPt(leg.fromIdx), ...leg.stops, stayPt(leg.toIdx)];
    const segs = leg.segments.length === pts.length - 1 ? leg.segments : [{ from: leg.from, to: leg.to, drive: leg.direct }];
    const segPts = leg.segments.length === pts.length - 1 ? pts : [pts[0], pts[pts.length - 1]];
    let cursor = 0;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s], from = segPts[s], to = segPts[s + 1];
      if (!at(to)) continue;
      // The first stop in the next town: after the last stop known to be in the town they leave; a stop whose place
      // isn't known counts when its name names no earlier town of the day and it starts late enough for the drive.
      let leftAt = -1;
      // "In the town they leave": within 20 km of it, or less when the next point is nearer than that (two stops on the way close together).
      const reach = at(from) ? Math.min(20, km(from, to) / 2) : 20;
      if (at(from)) d.items.forEach((x, i) => { if (i >= cursor && spot(i) && km(spot(i)!, from) < reach && !isDriveTransfer(x) && !isRide(x)) { cursor = i + 1; leftAt = minutes(x.time) + (Number(x.durationMinutes) || defaultMinutes(x)); } });
      const earlier = segPts.slice(0, s + 1).map((p) => lc(short(p.name))).filter(Boolean);
      const soonEnough = (x: ItineraryItem) => leftAt < 0 || !seg.drive || Number.isNaN(minutes(x.time)) || minutes(x.time) >= leftAt + seg.drive.hours * 60 * 0.8;
      const fits = (x: ItineraryItem, i: number) => i >= cursor && !isRide(x) && !isDriveTransfer(x) && !doers(x);
      // Checking in is in the town they arrive at, wherever the lookup put it (or didn't).
      const known = d.items.findIndex((x, i) => fits(x, i) && ((spot(i) && km(spot(i)!, to) < reach) || (s === segs.length - 1 && isCheckIn(x.place))));
      const unknown = d.items.findIndex((x, i) => fits(x, i) && !spot(i) && !earlier.some((n) => lc(x.place).includes(n)) && soonEnough(x));
      const idx = known >= 0 && unknown >= 0 ? Math.min(known, unknown) : Math.max(known, unknown);
      const mode = road ? "Drive" : cap(leg.mode);
      const text = `${mode} from ${short(from.name)}${seg.drive ? `, ${hm(seg.drive.hours * 60)} (${seg.drive.km} km)` : ""}`;
      if (idx >= 0) {
        if (road) {
          const x = d.items[idx], own = (x.transport || "").trim();
          const park = /\bpark/i.test(own) ? own.slice(own.search(/\bpark/i)).replace(/^[^a-z]*/i, "") : "";
          x.transport = park ? `${text}; ${park}` : text;
        }
        cursor = idx + 1;
        continue;
      }
      if (s === segs.length - 1 && road && !d.items.some((x, i) => i >= cursor && isDriveTransfer(x))) {
        const lastItem = d.items[d.items.length - 1];
        const start = lastItem && Number.isFinite(minutes(lastItem.time)) ? minutes(lastItem.time) + (Number(lastItem.durationMinutes) || defaultMinutes(lastItem)) : 9 * 60;
        const mins = seg.drive ? Math.round(seg.drive.hours * 60) : 60;
        d.items.push({ time: clock(start), durationMinutes: mins, place: `${short(from.name)} → ${short(to.name)} (car)`, kind: "transfer", description: `${text}.`, transport: `Car, ${hm(mins)}`, lat: to.lat, lng: to.lng, fixed: true });
        located.set(spotKey(d.date, d.items.length - 1), { lat: to.lat, lng: to.lng, how: "stay", name: short(to.name) });
        notes.push(`${d.date}: added the drive ${short(from.name)} → ${short(to.name)} at the end of the day.`);
      }
    }
    if (!road && !d.items.some(isRide)) {
      const mins = leg.direct ? Math.round(leg.direct.hours * 60) : 60;
      const to = stayPt(leg.toIdx);
      const first = d.items.findIndex((x, i) => spot(i) && at(to) && km(spot(i)!, to) < 20);
      const before = first > 0 ? d.items[first - 1] : null;
      const start = before && Number.isFinite(minutes(before.time)) ? minutes(before.time) + (Number(before.durationMinutes) || defaultMinutes(before)) : 9 * 60;
      const ride: ItineraryItem = { time: clock(start), durationMinutes: mins, place: `${short(leg.from)} → ${short(leg.to)} (${leg.mode})`, kind: "transfer", description: `By ${leg.mode}; check the current timetable.`, transport: cap(leg.mode), ...(at(to) ? { lat: to.lat, lng: to.lng, fixed: true } : {}) };
      d.items.splice(first >= 0 ? first : d.items.length, 0, ride);
      notes.push(`${d.date}: added the ${leg.mode} ${short(leg.from)} → ${short(leg.to)}, which the day didn't spell out.`);
    }
  }
  return notes;
}

/**
 * The outline's full days of one stay must differ: a place (or a day trip) assigned to several of them stays on the
 * first and is taken off the others, which are then written as days in the town itself. Returns notes.
 */
export function dedupeOutline(plans: Plans, frames: Frame[], trip: Trip) {
  const notes: string[] = [];
  const used = new Map<number, Set<string>>();
  for (const f of frames) {
    const p = plans.get(f.date);
    if (!p || f.kind !== "full" || !f.sleep) continue;
    const seen = used.get(f.sleep.idx) || new Set<string>();
    const keep = p.places.filter((x) => !seen.has(norm(x)));
    if (keep.length < p.places.length) {
      const gone = p.places.filter((x) => seen.has(norm(x)));
      notes.push(`${f.date}: ${gone.join(", ")} ${gone.length > 1 ? "were" : "was"} already on an earlier day of the stay; this day gets other places.`);
      p.places = keep;
      if (!keep.length) { p.title = `${short(trip.stays[f.sleep.idx].city)}: another day`; p.theme = `A different day in ${short(trip.stays[f.sleep.idx].city)} itself (or a different day trip): places not used on the other days, from the lists.`; }
    }
    for (const x of keep) seen.add(norm(x));
    used.set(f.sleep.idx, seen);
  }
  return notes;
}

interface Asker { (label: string, prompt: string, schema: { name: string; schema: object }, info: string): Promise<string> }

/**
 * Sends the broken days back, a few at a time, and keeps a rewrite only when it scores better (and keeps most of the
 * day and its must-sees). `extra` are problems from outside these checks (the page's), which a rewrite is trusted
 * to have addressed when it makes nothing else worse. Returns the issues still found.
 */
async function repairLoop(setup: Setup, ctx: CheckContext, days: Day[], ask: Asker, outlineText: string, stats: PlanChecks, onEvent: OnEvent, opts: { only?: Set<string>; extra?: Issue[]; rounds?: number } = {}) {
  const { trip, frames } = setup;
  const mustOn = (d: Day) => ctx.mustSee.filter((t) => visits(d, t)).length;
  const ledgerOf = (others: Day[]) => [...new Set(others.flatMap((d) => d.items.filter((x) => isSubstantive(x) || (isMealStop(x) && namedMeal(x.place))).map((x) => namedMeal(x.place) || x.place)))];
  let issues = validatePlan(days, ctx, opts.only);
  const rounds = opts.rounds ?? CHECKED_LIMITS.repairRounds;
  for (let round = 1; round <= rounds; round++) {
    const extra = round === 1 ? opts.extra || [] : [];
    const all = [...issues, ...extra];
    const broken = [...new Set(all.filter((x) => x.severity === "repair" && x.date && (!opts.only || opts.only.has(x.date))).map((x) => x.date!))].sort();
    if (!broken.length) break;
    stats.repairRounds = round;
    for (let i = 0; i < broken.length; i += CHECKED_LIMITS.repairBatch) {
      const these = broken.slice(i, i + CHECKED_LIMITS.repairBatch);
      onEvent({ type: "status", text: `Step 5: fixing ${these.join(", ")} (round ${round} of ${rounds})…` });
      const old = days.filter((d) => these.includes(d.date));
      const fr = frames.filter((f) => these.includes(f.date));
      const theirs = all.filter((x) => x.date && these.includes(x.date));
      let reply: Day[] | null = null;
      try {
        reply = daysOf(await ask(`Step 5: fix ${these.join(", ")}`, repairPrompt(trip, fr, old, theirs, ledgerOf(days.filter((d) => !these.includes(d.date))), outlineText), { name: "days", schema: daysSchema(schemaOptions(trip)) }, `${theirs.filter((x) => x.severity === "repair").length} problem(s) on ${these.length} day(s)`));
      } catch (e) {
        if (setup.trip && (e as any)?.name === "AbortError") throw e;
        if (e instanceof TruncatedError || /ran out of room/.test(errMsg(e))) stats.truncated++;
        else if (/Stopped/.test(errMsg(e))) throw e;
      }
      for (const date of these) {
        const cand = reply?.find((d) => d.date === date);
        if (!cand) continue;
        const before = days.find((d) => d.date === date)!;
        const tidied = tidyDays([cand], ctx).days[0];
        if (!tidied) continue;
        dropStandIns([tidied], { frames, stays: trip.stays, saved: setup.places });
        const only = new Set([date]);
        const now = score(validatePlan(days, ctx, only)) + 10 * extra.filter((x) => x.date === date).length;
        // The rewritten day's places and hops replace the old day's, in a trial context first.
        const trialLocated: Located = new Map([...ctx.located!].filter(([k]) => !k.startsWith(`${date}#`)));
        const trialHops = Object.fromEntries(Object.entries(ctx.hops!).filter(([k]) => !k.startsWith(`${date}#`)));
        await resolveDays([tidied], { frames, stays: trip.stays, saved: setup.places, nearby: trip.nearby || [], countries: countriesOf(trip), geo: setup.geo }, trialLocated);
        await travelNeeds([tidied], trialLocated, setup.route, trialHops, (date) => wakeStay(frames, trip.stays, date));
        shiftTimes([tidied], { ...ctx, located: trialLocated, hops: trialHops });
        const trial = days.map((d) => (d.date === date ? tidied : d));
        const next = score(validatePlan(trial, { ...ctx, located: trialLocated, hops: trialHops }, only));
        // A rewrite that empties the day passes the checks easily, so it also has to keep most of what the day held.
        const holds = tidied.items.length >= Math.ceil(before.items.length * 0.6);
        if (next < now && holds && mustOn(tidied) >= mustOn(before)) {
          days.splice(days.findIndex((d) => d.date === date), 1, tidied);
          ctx.located = trialLocated; ctx.hops = trialHops;
          stats.daysRepaired++;
        }
      }
    }
    issues = validatePlan(days, ctx, opts.only);
  }
  return issues;
}

/** Shared by planning and fixing: a sight still repeated after the repairs goes when its day keeps enough; drives the
 *  model wrote as stops are folded into the next stop; departure times without a source are marked. */
async function settle(setup: Setup, ctx: CheckContext, days: Day[], issues: Issue[], stats: PlanChecks) {
  const size = DAY_SIZE[ctx.pace];
  let changed = new Set<string>();
  // A rewrite may have brought a restaurant back twice in a day, a place twice in a day, or a lunch at dinner time.
  const meals = [...dropSameDayRepeats(days), ...quickFixMeals(days)];
  if (meals.length) { stats.fixedInCode.push(...meals); for (const n of meals) changed.add(n.slice(0, 10)); }
  // A restaurant still on two days after the repairs: the later visit becomes a meal near it (for them to pick a
  // place, or not); a full day still without lunch or dinner gets one near where they are then.
  for (const x of issues.filter((i) => i.code === "duplicate-restaurant" && i.date && i.item != null)) {
    const d = days.find((y) => y.date === x.date)!, stop = d.items[x.item!];
    if (!stop || !namedMeal(stop.place)) continue;
    const t = minutes(stop.time), word = t >= 16 * 60 ? "Dinner" : t >= 11 * 60 ? "Lunch" : t < 10 * 60 + 30 ? "Breakfast" : "Coffee";
    const was = stop.place; stop.place = `${word} near ${namedMeal(stop.place)}`; stop.kind = "meal";
    stats.fixedInCode.push(`${x.date}: "${was}" was already the restaurant on another day; made it "${stop.place}".`);
    changed.add(d.date);
  }
  for (const x of issues.filter((i) => i.code === "meal-missing" && i.date)) {
    const d = days.find((y) => y.date === x.date)!;
    const lunch = /No lunch/.test(x.message), want = lunch ? 12 * 60 + 30 : 18 * 60 + 45;
    // After the last stop that starts before then (or the last stop of the day), near it.
    const before = d.items.map((y, i) => [y, i] as const).filter(([y]) => !isTransfer(y) && minutes(y.time) <= want).at(-1);
    const after = before ? d.items[before[1] + 1] : undefined;
    const t = before ? Math.max(want, minutes(before[0].time) + (Number(before[0].durationMinutes) || defaultMinutes(before[0]))) : want;
    if (after && minutes(after.time) < t + 45 && minutes(after.time) > want - 60) continue; // no room: left for the notes
    const near = before && !isHotelStop(before[0]) ? `near ${namedMeal(before[0].place) || before[0].place}` : `in ${short(ctx.stays[ctx.frames.find((f) => f.date === d.date)?.sleep?.idx ?? 0]?.city || "town")}`;
    const meal: ItineraryItem = { time: clock(t), place: `${lunch ? "Lunch" : "Dinner"} ${near}`, kind: "meal", description: "", durationMinutes: lunch ? 60 : 90, transport: "Walk, 5 min" };
    d.items.splice(before ? before[1] + 1 : d.items.length, 0, meal);
    stats.fixedInCode.push(`${x.date}: added "${meal.place}" at ${meal.time} (the day had no ${lunch ? "lunch" : "dinner"}).`);
    changed.add(d.date);
  }
  // A place still on two days after the repairs: the later copy goes when the day keeps enough (a thin day is
  // better than the same place twice).
  for (const x of issues.filter((i) => i.code === "duplicate-place" && i.date && i.item != null).sort((a, b) => b.item! - a.item!)) {
    const d = days.find((y) => y.date === x.date)!;
    const frame = ctx.frames.find((f) => f.date === x.date)!;
    if (!d.items[x.item!]) continue;
    const left = d.items.filter((y, k) => k !== x.item && isSubstantive(y)).length;
    if (frame.kind === "travel" || left >= size.full[0] - 1) {
      const gone = d.items[x.item!];
      stats.fixedInCode.push(`${x.date}: left out "${gone.place}", already planned on another day.`);
      d.items.splice(x.item!, 1);
      // The ride that brought them there and the one back go with it (the ferry to Lokrum without Lokrum).
      const after = d.items[x.item!], before = d.items[x.item! - 1];
      if (after && isRide(after) && names(transferEnds(after.place)?.[0] || "", gone.place)) d.items.splice(x.item!, 1);
      if (before && isRide(before) && names(transferEnds(before.place)?.[1] || "", gone.place)) d.items.splice(x.item! - 1, 1);
      changed.add(d.date);
    }
  }
  const folded = foldTransfers(days);
  if (folded.length) {
    stats.fixedInCode.push(`Folded ${folded.length} drive${folded.length > 1 ? "s" : ""} or walk${folded.length > 1 ? "s" : ""} written as stops into the stop${folded.length > 1 ? "s" : ""} they lead to.`);
    for (const n of folded) changed.add(n.slice(0, 10));
  }
  for (const d of days) for (const x of d.items) {
    if (unverifiedTimes(x, ctx.known).length && !/not verified/i.test(x.description)) {
      x.description = `${x.description} (Departure times not verified: check the current timetable.)`.trim();
      stats.fixedInCode.push(`${d.date} "${x.place}": marked its departure times as not verified.`);
    }
  }
  if (changed.size) await refresh(setup, ctx, days.filter((d) => changed.has(d.date)));
}

export async function planChecked(input: Trip, allPlaces: Place[], onEvent: OnEvent, abort: AbortSignal, route: RouteFn = roadRoute, geo: GeoFn = geoCached): Promise<RunResult> {
  const t0 = Date.now();
  const places = withoutStays(input, allPlaces);
  const { engine, billing, local } = engineOf(String(input.model || ""));
  const stats: PlanChecks = { version: CHECKED_VERSION, requests: 0, enforced: 0, fallback: 0, truncated: 0, repairRounds: 0, daysRepaired: 0, found: {}, open: [], fixedInCode: [], partial: false };
  let tokens = 0, thinking = "";
  const ask: Asker = async (label, prompt, schema, info) => {
    if (abort.aborted) throw new Error("Stopped");
    onEvent({ type: "prompt", label, info: `${engine} · ${info} · answer as JSON following the "${schema.name}" schema (enforced by the provider where it can, checked in code either way) · ${CHECKED_VERSION}`, text: prompt });
    stats.requests++;
    let start = tokens;
    return askModel(String(input.model), prompt, (n) => { tokens = start + n; onEvent({ type: "tokens", count: tokens, estimated: !local }); }, {
      signal: abort, schema, maxTokens: 32000, timeoutMs: CHECKED_LIMITS.timeoutMs,
      onFormat: (ok) => { if (ok) stats.enforced++; else stats.fallback++; },
      onText: (_r, thought) => { if (thought.length > thinking.length) thinking = thought; },
      onRetry: (msg) => { start = tokens; onEvent({ type: "status", text: msg }); },
    });
  };

  // --- Research (the route has already used a research model of its own, if one is set) ---
  let notes = input.researchNotes || "", urls: string[] = [];
  if (input.research) {
    if (/^(local\||api\|gemini\|)/.test(String(input.model))) {
      onEvent({ type: "status", text: "Researching the trip online…" });
      try {
        const r = await researchWith(String(input.model), input, places, onEvent, abort);
        notes = r.notes; urls = r.urls;
        if (notes) onEvent({ type: "notes", text: `**Research findings**\n\n${notes}` });
      } catch (e) {
        if (abort.aborted) throw e;
        onEvent({ type: "notes", text: `**No web research:** ${errMsg(e).slice(0, 160)}.` });
      }
    } else {
      onEvent({ type: "notes", text: "**No web research:** the checked planner researches with Gemini or a local model; choose one as the research model under Settings → Search & places to research with this model's plans." });
    }
  }
  const trip: Trip = { ...input, research: false, researchNotes: notes ? annotateResearch(notes, input) : "" };

  // --- 1. The frame ---
  onEvent({ type: "status", text: "Step 1: working out the days and checking the roads for the stops on the way…" });
  const frames = buildFrames(trip, places);
  if (!frames.length) throw new Error("The trip has no dates.");
  await routeFrames(frames, trip, route);
  const setup: Setup = { trip, places, frames, route, geo };
  const schema = daysSchema(schemaOptions(trip));

  // --- 2. The outline ---
  const { perStay, unplaced } = placesByStay(trip, places);
  const nearbyOf = (city: string) => (trip.nearby || []).filter((n) => lc(n.city) === lc(city));
  const sightCount = local ? 10 : 18;
  const candidates = trip.stays.map((s, i) => ({ city: s.city, saved: perStay[i] || [], sights: Number(s.nights) > 0 ? nearbyOf(s.city).flatMap((n) => n.sights).slice(0, (perStay[i] || []).length >= 15 ? 6 : sightCount) : [], wished: Number(s.nights) > 0 ? nearbyOf(s.city).flatMap((n) => n.wished || []) : [] }))
    .filter((c) => c.saved.length || c.sights.length || c.wished.length);
  onEvent({ type: "status", text: "Step 2: deciding which day gets what…" });
  const oPrompt = outlinePrompt({ trip, frames, candidates, unplaced });
  let outline: Outline | null = null;
  for (let attempt = 0; attempt < 2 && !outline; attempt++) {
    const reply = await ask(attempt ? "Outline (asked again)" : "Step 2: the outline", attempt ? `${oPrompt}\n\nYour last answer wasn't usable JSON. Answer with the JSON only.` : oPrompt, { name: "outline", schema: OUTLINE_SCHEMA }, "which day gets which places");
    try { const o = dropNulls(parseJsonLoose(reply)); if (o && Array.isArray(o.days)) outline = o as Outline; } catch { /* asked again */ }
  }
  if (!outline) throw new Error("The model didn't return a usable outline of the days. Try again, or switch Settings → Plan style → Planner back to Standard.");
  const planOf = (o: Outline): Plans => new Map(o.days.filter((d) => d?.date).map((d) => [d.date, { title: String(d.title || ""), theme: String(d.theme || ""), places: [...new Set((d.places || []).concat((d as any).wayStops || []).map(String))] }]));
  const outlineCheck = (o: Outline) => {
    const plans = planOf(o);
    const problems = outlineProblems(trip, { days: frames.map((f) => ({ date: f.date, city: f.sleep?.city || f.legs.at(-1)?.to || "", title: plans.get(f.date)?.title, places: plans.get(f.date)?.places || [] })) })
      // Must-sees the model honestly left out (in "unused") aren't a problem of the outline.
      .map((p) => p.replace(/^These must-sees aren't on any day; each must be: (.*)\.$/, (_m, list: string) => {
        const left = list.split("; ").filter((t: string) => !(o.unused || []).some((u) => names(u.place, t)));
        return left.length ? `These must-sees aren't on any day; each must be (or go in "unused" with the reason): ${left.join("; ")}.` : "";
      })).filter(Boolean);
    const missing = frames.filter((f) => !plans.has(f.date)).map((f) => f.date);
    if (missing.length) problems.push(`These dates have no entry: ${missing.join(", ")}.`);
    for (const f of frames) {
      const p = plans.get(f.date);
      if (f.kind === "full" && !(p?.places.length)) problems.push(`${f.date} is a full day in ${short(f.sleep?.city || "")} with no places; give it ${DAY_SIZE[paceOf(trip.pace)].full[0]}-${DAY_SIZE[paceOf(trip.pace)].full[1]}.`);
      if (f.kind !== "travel") continue;
      const load = travelLoad(f);
      const wayKept = f.legs.flatMap((l) => l.stops).filter((s) => (p?.places || []).some((x) => names(x, s.name)));
      const extra = (p?.places || []).filter((x) => !f.legs.some((l) => l.stops.some((s) => names(x, s.name))));
      if (load && load.total > TOO_LONG_HOURS && wayKept.length >= f.legs.reduce((n, l) => n + l.stops.length, 0) && f.legs.some((l) => l.stops.length > 1))
        problems.push(`${f.date} keeps every stop on the way although the day comes to about ${Math.round(load.total)} h: move one to a full day nearby (its day-trip option) or to "unused" with the reason.`);
      if (extra.length > 2) problems.push(`${f.date} is a travel day with ${extra.length} other places (${extra.join("; ")}); keep at most 2 light ones.`);
    }
    return problems;
  };
  let problems = outlineCheck(outline);
  if (problems.length) {
    onEvent({ type: "status", text: `Step 2: fixing the outline (${problems.length} problem${problems.length > 1 ? "s" : ""})…` });
    const reply = await ask("Step 2: the outline, fixed", `${oPrompt}\n\n## Your outline so far\n${JSON.stringify(outline)}\n\n## Fix these problems found by checks in code, keep everything else\n${problems.map((p) => `- ${p}`).join("\n")}\n\nAnswer with the whole corrected outline JSON only.`, { name: "outline", schema: OUTLINE_SCHEMA }, `${problems.length} problem(s) found in the outline`);
    try {
      const fixed = dropNulls(parseJsonLoose(reply)) as Outline;
      if (fixed && Array.isArray(fixed.days) && outlineCheck(fixed).length < problems.length) { outline = fixed; problems = outlineCheck(fixed); }
    } catch { /* keeps the first */ }
  }
  if (outline.planningNotes) onEvent({ type: "notes", text: outline.planningNotes });
  const plans = planOf(outline);
  stats.fixedInCode.push(...dedupeOutline(plans, frames, trip));
  const outlineText = frames.map((f) => { const p = plans.get(f.date); return `- ${f.date} ${f.sleep ? short(f.sleep.city) : "end"}: ${p?.title || ""}${p?.places.length ? ` (${p.places.join("; ")})` : ""}`; }).join("\n");

  // --- 3. The days, a few at a time, with a shared ledger ---
  const byTitle = new Map(places.map((p) => [lc(p.title), p]));
  const findings = (trip.researchNotes || "").split("\n").filter((l) => l.trim());
  const written = new Map<string, Day>();
  let lastError: unknown = null;
  const used = () => [...new Set([...written.values()].flatMap((d) => d.items.filter((x) => (isSubstantive(x) || (isMealStop(x) && namedMeal(x.place))) && !/\bhotel\b/i.test(x.place)).map((x) => namedMeal(x.place) || x.place)))];
  const writeBatch = async (batch: Frame[], label: string, depth = 0): Promise<void> => {
    const cities = new Set(batch.flatMap((f) => [f.sleep?.city, ...f.legs.flatMap((l) => [l.from, l.to])]).filter(Boolean).map(lc));
    const lists = (trip.nearby || []).filter((n) => cities.has(lc(n.city)));
    const named = batch.flatMap((f) => [...(plans.get(f.date)?.places || []), ...f.legs.flatMap((l) => l.stops.map((s) => s.name))]);
    const saved = [...new Set(named.map((n) => byTitle.get(lc(n)) || places.find((p) => names(n, p.title) && names(p.title, n))).filter((p): p is Place => !!p))];
    const allSights = lists.flatMap((n) => n.sights);
    const sights = [...allSights.filter((p) => named.some((n) => lc(n) === lc(p.name))), ...allSights.filter((p) => !named.some((n) => lc(n) === lc(p.name))).slice(0, local ? 6 : 10)];
    const sleepLists = (trip.nearby || []).filter((n) => batch.some((f) => f.sleep && lc(f.sleep.city) === lc(n.city)));
    const food: NearbyPlace[] = sleepLists.flatMap((n) => n.food).slice(0, local ? 12 : 18);
    const wished: NearbyPlace[] = sleepLists.flatMap((n) => n.wished || []);
    const keys = [...named, ...[...cities].map((c) => c.split(",")[0])].map((n) => lc(n).replace(/\(.*$/, "").trim()).filter((n) => n.length > 3);
    const research = findings.filter((l) => keys.some((k) => lc(l).includes(k))).join("\n").slice(0, 3000);
    const before = [...written.values()].filter((d) => d.date < batch[0].date).sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.items.at(-1)?.place;
    const prompt = batchPrompt({ trip, frames: batch, outline: outlineText, plans, saved, sights, food, wished, used: used(), research, before });
    const dates = new Set(batch.map((f) => f.date));
    let got: Day[] | null = null;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        got = daysOf(await ask(`${label}${attempt ? " (asked again)" : ""}`, attempt ? `${prompt}\n\nYour last answer wasn't usable. Answer with the JSON only.` : prompt, { name: "days", schema }, `${batch.length} day(s): ${[...dates].join(", ")}`));
      } catch (e) {
        if (abort.aborted) throw e;
        if (e instanceof TruncatedError || /ran out of room/.test(errMsg(e))) { stats.truncated++; break; }
        lastError = e; // asked again; days still missing afterwards are asked for in smaller parts
      }
    }
    // A day that came back without stops wasn't written: asked for again below.
    for (const d of got || []) if (dates.has(d.date) && !written.has(d.date) && d.items.length) written.set(d.date, d);
    const left = batch.filter((f) => !written.has(f.date));
    // Cut off or unusable: the days still missing are asked for in smaller groups (one at a time at the end).
    if (left.length && depth < 2 && (left.length > 1 || depth === 0)) {
      const half = Math.ceil(left.length / 2);
      for (const part of left.length > 1 ? [left.slice(0, half), left.slice(half)] : [left]) await writeBatch(part, `${label}, again for ${part.map((f) => f.date).join(", ")}`, depth + 1);
    }
  };
  const batches = batchFrames(frames, local ? CHECKED_LIMITS.batchLocal : CHECKED_LIMITS.batchCloud);
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    onEvent({ type: "status", text: `Step 3: writing ${b.length > 1 ? `days ${b[0].date.slice(5)} to ${b.at(-1)!.date.slice(5)}` : `${b[0].date.slice(5)}`} (${i + 1} of ${batches.length})…` });
    await writeBatch(b, `Step 3: days ${i + 1} of ${batches.length}`);
    onEvent({ type: "progress", days: written.size });
  }

  // Not one day came out: the model or server is failing, not the plan (no point checking placeholders).
  if (!written.size) throw lastError instanceof Error ? lastError : new Error("The model didn't write any of the days. Try again, or switch Settings → Plan style → Planner back to Standard.");

  // --- 4. Where everything is, then the checks ---
  onEvent({ type: "status", text: "Step 4: locating every stop and checking every day (times between stops, opening hours, repeats, must-sees)…" });
  const { days: tidied, notes: tidyNotes } = tidyDays([...written.values()], { frames });
  let days = tidied;
  stats.fixedInCode.push(...tidyNotes, ...dropStandIns(days, { frames, stays: trip.stays, saved: places }));
  const { ctx, notes: renamed } = await contextFor(setup, days);
  stats.fixedInCode.push(...renamed);
  stats.fixedInCode.push(...dropSameDayRepeats(days), ...quickFixMeals(days), ...quickFixHours(days, ctx), ...shiftTimes(days, ctx));
  let issues = validatePlan(days, ctx);
  for (const x of issues) stats.found[x.code] = (stats.found[x.code] || 0) + 1;

  // --- 5. Only the broken days go back ---
  issues = await repairLoop(setup, ctx, days, ask, outlineText, stats, onEvent);
  await settle(setup, ctx, days, issues, stats);

  // --- 6. Assembly ---
  for (const f of frames) if (!days.some((d) => d.date === f.date)) {
    const p = plans.get(f.date);
    days.push({ date: f.date, city: f.sleep?.city || f.legs.at(-1)?.to || "", title: p?.title || "Not written", estimatedCost: 0,
      notes: "This day couldn't be written in detail; use Re-plan on it.", items: (p?.places || []).map((n) => ({ time: "", place: n, description: "" })) });
    stats.partial = true;
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  for (const d of days) stats.fixedInCode.push(...finishDay(d, frames.find((f) => f.date === d.date)!, trip, ctx.located!));
  for (const d of days) d.estimatedCost = d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0);
  const holidays: HolidayOrEvent[] = frames.flatMap((f) => f.holidays.map((h) => ({ date: f.date, name: h.split(",")[0], where: f.countries.join(", "), impact: `Public holiday where they are that day (${h.split(", ").slice(1).join(", ")}): shops and some sights may be closed or busier; check opening hours.` })));
  const events = filterEvents((outline.events || []).filter((e) => e?.name), ctx);
  if (events.dropped.length) stats.fixedInCode.push(...events.dropped.map((x) => `Left out an event: ${x}.`));
  const seen = new Set(holidays.map((h) => lc(h.name)));
  const itinerary = normalizeItinerary({
    summary: outline.summary || "", destination: outline.destination, localCurrency: localCurrency(trip), days, tips: outline.tips || [],
    holidaysAndEvents: [...holidays, ...events.kept.filter((e) => !seen.has(lc(e.name)))],
    unused: (outline.unused || []).filter((u) => u?.place), totalEstimatedCost: 0,
  }, Number(trip.travelers) || 1, trip.people)!;
  // Must-sees left out without a word: the reason when the frame shows the travel day was too long.
  for (const f of frames) for (const l of f.legs) for (const s of l.stops) {
    const load = travelLoad(f);
    if (load && load.total > TOO_LONG_HOURS && !itinerary.days.some((d) => visits(d, s.name)) && !(itinerary.unused || []).some((u) => names(u.place, s.name)))
      itinerary.unused = [...(itinerary.unused || []), { place: s.name, reason: `The travel day ${f.date} would come to about ${Math.round(load.total)} h with all its stops (driving times from a routing service), so it didn't fit${s.alternative ? `; it could be a day trip from ${short(s.alternative.city)}` : ""}.` }];
  }
  addMissingMustSees(itinerary, ctx.mustSee);
  for (const d of itinerary.days) d.estimatedCost = d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0);
  itinerary.totalEstimatedCost = itinerary.days.reduce((n, d) => n + d.estimatedCost, 0);
  if (urls.length || notes) itinerary.sources = [...new Set([...urls, ...(notes.match(/https?:\/\/[^\s)\]]+/g) || [])])];

  // The report: what was checked, what code fixed, what is still open. Normalising may have dropped or merged stops,
  // so where everything is, is indexed again first.
  await refresh(setup, ctx, itinerary.days);
  stats.fixedInCode.push(...shiftTimes(itinerary.days, ctx));
  for (const d of itinerary.days) for (const x of d.items) if (x.transport) x.transport = x.transport.replace(/^\s*start of (the )?day\s*[;,.]?\s*/i, "").trim();
  const final = validatePlan(itinerary.days, ctx);
  stats.open = final.filter((x) => x.severity !== "warn").map(({ code, severity, date, message }) => ({ code, severity, date, message }));
  stats.partial = stats.partial || final.some((x) => x.severity === "hard");
  const warnCount = final.filter((x) => x.severity === "warn").reduce<Record<string, number>>((m, x) => ({ ...m, [x.code]: (m[x.code] || 0) + 1 }), {});
  const stops = itinerary.days.flatMap((d) => d.items.map((x, i) => ctx.located!.get(spotKey(d.date, i))));
  const fixedCount = stops.filter((s) => s && s.how !== "near").length;
  const report = [
    `**How this plan was checked** (checked planner, experimental, ${CHECKED_VERSION})`,
    `- ${stats.requests} requests: an outline, the days a few at a time${stats.repairRounds ? `, then ${stats.daysRepaired} day${stats.daysRepaired === 1 ? "" : "s"} rewritten to fix what the checks found` : ""}. The JSON format was enforced by the provider on ${stats.enforced} of ${stats.enforced + stats.fallback}${stats.truncated ? `; ${stats.truncated} answer${stats.truncated > 1 ? "s were" : " was"} cut off and asked for again in smaller parts` : ""}.`,
    `- ${fixedCount} of ${stops.length} stops located in code (your saved places, OpenStreetMap, lookups by name); ${Object.keys(ctx.hops || {}).length} stretch${Object.keys(ctx.hops || {}).length === 1 ? "" : "es"} between stops checked against a routing service; drives between towns written from the routing service; costs added up in code; holidays only where you are that day.`,
    ...(Object.entries(stats.found).some(([, n]) => n) ? [`- The first check found: ${Object.entries(stats.found).filter(([k]) => !/cost-unknown|no-duration|needless-transfer/.test(k)).map(([k, n]) => `${n}× ${k.replace(/-/g, " ")}`).join(", ") || "only notes"}.`] : []),
    ...(stats.fixedInCode.length ? [`- Fixed in code: ${stats.fixedInCode.slice(0, 8).join(" ")}${stats.fixedInCode.length > 8 ? ` (and ${stats.fixedInCode.length - 8} more)` : ""}`] : []),
    stats.open.length ? `- Still open:\n${stats.open.slice(0, 12).map((x) => `  - ${x.date || ""} ${x.message}`).join("\n")}` : "- No open problems in these checks.",
    ...(Object.keys(warnCount).length ? [`- Notes: ${Object.entries(warnCount).map(([k, n]) => `${n}× ${k.replace(/-/g, " ")}`).join(", ")}.`] : []),
  ].join("\n");
  const reasoning = `${outline.planningNotes || ""}\n\n${report}${notes ? `\n\n**Research findings**\n\n${trip.researchNotes}` : ""}`.trim();
  return {
    itinerary, reasoning, thinking: thinking.slice(0, 20000), durationMs: Date.now() - t0, tokens, engine, billing, checks: stats,
  };
}

/**
 * The page's fix round for a plan: the problems its own checks found (a place closed then, a repeat, a stop far from
 * its day) go back with this planner's rules, so the fix keeps the frame, the real times between stops and the ledger,
 * and a rewrite is kept only when it isn't worse. Only the fixed days come back, as the page expects.
 */
export async function fixChecked(input: Trip, places: Place[], onEvent: OnEvent, abort: AbortSignal, route: RouteFn = roadRoute, geo: GeoFn = geoCached): Promise<RunResult> {
  const t0 = Date.now();
  const fix = input.fix!;
  const { engine, billing, local } = engineOf(String(input.model || ""));
  const stats: PlanChecks = { version: CHECKED_VERSION, requests: 0, enforced: 0, fallback: 0, truncated: 0, repairRounds: 0, daysRepaired: 0, found: {}, open: [], fixedInCode: [], partial: false };
  let tokens = 0;
  const ask: Asker = async (label, prompt, schema, info) => {
    if (abort.aborted) throw new Error("Stopped");
    onEvent({ type: "prompt", label, info: `${engine} · ${info} · ${CHECKED_VERSION}`, text: prompt });
    stats.requests++;
    let start = tokens;
    return askModel(String(input.model), prompt, (n) => { tokens = start + n; onEvent({ type: "tokens", count: tokens, estimated: !local }); }, {
      signal: abort, schema, maxTokens: 32000, timeoutMs: CHECKED_LIMITS.timeoutMs,
      onFormat: (ok) => { if (ok) stats.enforced++; else stats.fallback++; },
      onRetry: (msg) => { start = tokens; onEvent({ type: "status", text: msg }); },
    });
  };
  const trip: Trip = { ...input, research: false, researchNotes: input.researchNotes ? annotateResearch(input.researchNotes, input) : "" };
  onEvent({ type: "status", text: "Checking the days against the trip's frame and the map…" });
  const frames = buildFrames(trip, places);
  if (!frames.length) throw new Error("The trip has no dates.");
  await routeFrames(frames, trip, route);
  const setup: Setup = { trip, places, frames, route, geo };
  const dates = new Set(fix.problems.map((p) => fix.itinerary.days[p.day]?.date).filter((d): d is string => !!d));
  const extra: Issue[] = fix.problems.map((p) => ({ code: "page-check", severity: "repair" as const, date: fix.itinerary.days[p.day]?.date, message: p.text })).filter((x) => x.date);
  const { days } = tidyDays(structuredClone(fix.itinerary.days), { frames });
  dropStandIns(days.filter((d) => dates.has(d.date)), { frames, stays: trip.stays, saved: places });
  const { ctx } = await contextFor(setup, days);
  const outlineText = days.map((d) => `- ${d.date} ${short(d.city)}: ${d.title}${d.items.length ? ` (${d.items.map((x) => x.place).join("; ")})` : ""}`).join("\n");
  for (const x of [...validatePlan(days, ctx, dates), ...extra]) stats.found[x.code] = (stats.found[x.code] || 0) + 1;
  const issues = await repairLoop(setup, ctx, days, ask, outlineText, stats, onEvent, { only: dates, extra, rounds: 2 });
  await settle(setup, ctx, days.filter((d) => dates.has(d.date)), issues, stats);
  const fixed = days.filter((d) => dates.has(d.date));
  for (const d of fixed) {
    stats.fixedInCode.push(...finishDay(d, frames.find((f) => f.date === d.date)!, trip, ctx.located!));
    d.estimatedCost = d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0);
  }
  const itinerary = normalizeItinerary({ summary: "", days: fixed, totalEstimatedCost: 0 }, Number(trip.travelers) || 1, trip.people);
  if (!itinerary) throw new Error("Nothing came back for the days to fix.");
  const open = validatePlan(days, ctx, dates).filter((x) => x.severity !== "warn");
  stats.open = open.map(({ code, severity, date, message }) => ({ code, severity, date, message }));
  const reasoning = [`Fixed with the checked planner: ${stats.daysRepaired} of ${dates.size} day${dates.size === 1 ? "" : "s"} rewritten.`, stats.fixedInCode.length ? `Fixed in code: ${stats.fixedInCode.join(" ")}` : "", open.length ? `Still open: ${open.map((x) => `${x.date} ${x.message}`).join(" ")}` : ""].filter(Boolean).join("\n");
  return { itinerary, reasoning, durationMs: Date.now() - t0, tokens, engine, billing, checks: stats };
}

export type { Issue };
