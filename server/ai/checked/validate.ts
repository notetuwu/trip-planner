// Deterministic checks of a plan against the trip's frame (frames.ts) and where its stops really are (resolve.ts): no
// model involved, so they're cheap, repeatable and testable. Each problem names its day (and stop), how bad it is and
// what to do, so planner.ts can send only the broken days back to the model, and tell the travelers honestly what is
// still wrong.
//   hard   - the plan is structurally wrong (a day missing); it can't be shown as complete
//   repair - wrong but fixable by rewriting that day (no time to get from one stop to the next, a place closed then, a
//            duplicate, a travel day overloaded, a full day with nothing in it)
//   warn   - worth knowing, not worth a rewrite (a price not known, a thin day: never filled up with filler)
import type { Day, ItineraryItem, Place } from "../../../shared/types";
import { DAY_SIZE, DAY_TRIP_MINUTES, type Pace } from "../../../shared/planner";
import { km } from "../../../shared/route";
// Pure (data in, no page): the same duplicate rule as the plan's Fix bar.
import { findDuplicates } from "../../../web/src/itinerary/duplicates";
import { checkHours } from "../../trip/hours";
import { type NearbyList, type NearbyPlace, wantsHere } from "../../trip/nearby";
import { type Want, WANT_KINDS } from "../../trip/prefs";
import { detourKm, type Frame, legHours } from "./frames";
import { type Located, type Spot, spotKey } from "./resolve";
import { clock, doers, hm, isCheckIn, isCheckOut, isDriveTransfer, isHotelStop, isMealStop, isRide, isTransfer, lc, minutes, namedMeal, names, norm, placeOf, short, transferEnds, words } from "./text";

export type Severity = "hard" | "repair" | "warn";
export interface Issue {
  code: string;
  severity: Severity;
  /** The day it's about (YYYY-MM-DD), when it's about one. */
  date?: string;
  /** The stop's index in that day. */
  item?: number;
  message: string;
}

export interface CheckContext {
  frames: Frame[];
  stays: { city: string; start: string; nights: number; lat?: number; lng?: number }[];
  mustSee: string[];
  skip: string[];
  saved: Place[];
  pace: Pace;
  /** For the whole group, per day. */
  dailyBudget: number;
  /** Everything the planner was given that can verify a departure time (train lines, research, bookings, requests). */
  known: string;
  /** How they get around within a town: "car", "transit", "mixed" (a car between stays, public transport in town) or "". */
  getAround?: string;
  /** Where each stop is (resolve.ts), by `${date}#${index}`. */
  located?: Located;
  /** Minutes a routing service says it takes to reach a stop from the one before it (far apart only), by `${date}#${index}`. */
  hops?: Record<string, number>;
  /** The kinds of place they asked to see (prefs.ts), and the real ones found for them per town (nearby.ts). */
  wants?: Want[];
  wished?: NearbyList[];
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
const at = (p?: { lat?: number; lng?: number } | null): p is { lat: number; lng: number } => typeof p?.lat === "number" && typeof p?.lng === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lng);
export { isTransfer, names, minutes };
const LOGISTICS = /check[- ]?(in|out)|\bhotel\b|\bhostel\b|\bstation\b|\bairport\b|\bparking\b|^(free time|rest|relax)/i;
/** A sight or activity that counts towards the day's size (not a meal, a transfer, the hotel or checking in). */
const CAFE = /^(caf[ée]|caffè|kavarna|kavana|coffee|bar|pub|konoba|restaurant|ristorante|trattoria|gostilna|bistro)(?![\p{L}])/iu;
export const isSubstantive = (x: ItineraryItem) => !isMealStop(x) && !CAFE.test(x.place) && !isTransfer(x) && x.kind !== "other" && !LOGISTICS.test(x.place);

/** A day visits a place when a stop other than a transfer or a meal near it names it (driving towards it, or lunch
 *  "near Lake Bled", isn't seeing it; a named restaurant that is the place counts). */
export const visits = (d: Day, title: string) => d.items.some((x) => !isTransfer(x) && !(isMealStop(x) && !namedMeal(x.place)) && names(x.place, title));

/** Default length of a stop when the model gave none. */
export function defaultMinutes(x: ItineraryItem) {
  if (isTransfer(x)) return 60;
  if (isMealStop(x)) return /breakfast|coffee|cake|snack|ice cream|gelato/i.test(x.place) ? 45 : 75;
  return x.kind === "other" ? 30 : 90;
}
const lengthOf = (x: ItineraryItem) => (Number(x.durationMinutes) > 0 ? Number(x.durationMinutes) : defaultMinutes(x));

// A departure time stated for a ferry, train or bus ("the 08:30 car ferry", "ferry at 17:00", "departs 9:15").
const SCHEDULE = /\b(ferry|ferries|catamaran|boat|train|bus|coach|flight)\b[^.;]{0,40}?\b(\d{1,2}:\d{2})\b|\b(\d{1,2}:\d{2})\b[^.;]{0,25}?\b(ferry|catamaran|boat|train|bus|coach|flight|departure|crossing)\b|\bdepart(?:s|ure|ing)?\b[^.;]{0,15}?\b(\d{1,2}:\d{2})\b/gi;

/** Departure times a stop states that nothing the planner was given backs up. */
export function unverifiedTimes(x: ItineraryItem, known: string) {
  const text = [x.place, x.transport, x.description].filter(Boolean).join(" ");
  const times = new Set<string>();
  for (const m of text.matchAll(SCHEDULE)) {
    const t = m[2] || m[3] || m[5];
    if (t && !known.includes(t) && !known.includes(t.replace(/^0/, ""))) times.add(t);
  }
  return [...times];
}

const WALK = /\b(walk|walking|on foot|stroll|hike)\b/i;
const TRANSIT = /\b(metro|tram|bus|train|subway|u-?bahn|s-?bahn|underground|line \d|transit|public transport|streetcar|funicular)\b/i;
const CAR = /\b(drive|driving|(?<!cable[ -])car(?!\s*ferry)|taxi|uber|park|parking)\b/i;
const RIDE_WORDS = /\b(ferry|boat|catamaran|flight|plane|cable ?car|gondola|ropeway|lift|cruise)\b/i;

/**
 * Minutes it takes to get from one stop to the next, from how far apart they are and how the plan says they go
 * (routed minutes from a routing service when given). Null when it can't be told (a boat, a flight).
 */
export function needMinutes(dist: number, transport: string | undefined, routed?: number | null): number | null {
  if (typeof routed === "number") return Math.round(routed * 1.1 + (dist >= 15 ? 10 : 5));
  if (dist < 0.08) return 0;
  const t = transport || "";
  if (RIDE_WORDS.test(t) && !CAR.test(t)) return null;
  if (WALK.test(t) && !CAR.test(t) && !TRANSIT.test(t)) return Math.round(dist * 12);
  if (TRANSIT.test(t)) return Math.round(10 + dist * 4);
  if (CAR.test(t)) return Math.round(dist < 15 ? 8 + dist * 2.5 : 15 + dist * 1.2);
  if (dist < 1.5) return Math.round(dist * 12);
  return Math.round(dist < 15 ? 10 + dist * 3 : 15 + dist * 1.2);
}

// --- What they asked to see ---
/** Words of a wish that don't name a kind of place. */
const WISH_STOP = new Set(["vibrant", "quirky", "cascading", "imperial", "famous", "local", "visit", "some", "nice", "beautiful", "great", "good", "cool", "culture", "explore", "enjoy", "discover", "there", "their", "would", "like", "want", "maybe"]);

/** A stop meets a wish when it names one of the places found for it (or stands at one), is at a place of that kind
 *  (as OpenStreetMap files it), or its name carries the wish's own words ("thermal" in "Széchenyi Thermal Baths"). */
export function meetsWish(x: ItineraryItem, spot: Spot | undefined, w: Want, candidates: NearbyPlace[]) {
  if (isTransfer(x) || isHotelStop(x) || isMealStop(x) && !namedMeal(x.place)) return false;
  if (candidates.some((c) => names(x.place, c.name) || (spot && km(spot, c) < 0.15))) return true;
  const kindWords = words(WANT_KINDS[w.kind]?.label || "").filter((k) => !/^(or|and|historic)$/.test(k)).map((k) => k.slice(0, 4));
  if (spot?.kind && kindWords.some((k) => norm(spot.kind).includes(k))) return true;
  // What the stop's own text says it is ("the park's cascading waterfalls").
  const said = norm(x.description || "");
  if (said && kindWords.some((k) => k.length >= 4 && said.includes(k))) return true;
  const stems = [...words(w.what).filter((s) => s.length >= 5 && !WISH_STOP.has(s)).map((s) => s.slice(0, 5)), ...kindWords];
  const name = norm(x.place);
  return stems.some((s) => name.includes(s));
}

/** Each wish needs a stop somewhere in the trip. One without: the emptiest full day of the stay it names (or of any
 *  stay) is asked to take it, with the real places found nearby; a wish no stay can serve is only reported. */
function wishIssues(days: Day[], ctx: CheckContext, only?: Set<string>): Issue[] {
  const out: Issue[] = [];
  if (!ctx.wants?.length) return out;
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const w of ctx.wants) {
    const near = (city: string) => (ctx.wished || []).filter((n) => lc(short(n.city)) === lc(short(city))).flatMap((n) => (n.wished || []).filter((p) => p.for === w.what));
    const candidates = (ctx.wished || []).flatMap((n) => (n.wished || []).filter((p) => p.for === w.what));
    if (days.some((d) => d.items.some((x, i) => meetsWish(x, ctx.located?.get(spotKey(d.date, i)), w, candidates)))) continue;
    const stayIdx = ctx.stays.map((_, i) => i).filter((i) => Number(ctx.stays[i].nights) > 0 && (!w.where || wantsHere(w.where, ctx.stays[i].city)));
    const frames = ctx.frames.filter((f) => f.sleep && stayIdx.includes(f.sleep.idx) && byDate.has(f.date));
    const full = frames.filter((f) => f.kind === "full");
    // Of the stays that can serve it, the one with places found for it; of its full days, the one with the least in it.
    const ranked = (full.length ? full : frames).map((f) => ({ f, found: near(ctx.stays[f.sleep!.idx].city).length, n: byDate.get(f.date)!.items.filter((x) => isSubstantive(x)).length }))
      .sort((a, b) => Number(b.found > 0) - Number(a.found > 0) || a.n - b.n);
    const pick = ranked[0]?.f;
    const where = w.where ? ` (${w.where})` : "";
    if (!pick) { if (!only) out.push({ code: "wish-unmet", severity: "warn", message: `They asked to see ${w.what}${where}; no stop in the trip is one, and no stay is there to plan one from.` }); continue; }
    if (only && !only.has(pick.date)) continue;
    const town = short(ctx.stays[pick.sleep!.idx].city);
    const list = near(town).slice(0, 5).map((c) => `${c.name}${c.hours ? ` (hours ${c.hours})` : ""}`).join("; ");
    out.push({ code: "wish-unmet", severity: "repair", date: pick.date, message: `They asked to see ${w.what}${where}, and no stop in the trip is one. Add one on this day or another day in ${town}${list ? ` (real ones found nearby: ${list})` : ", a real one you know of"}, dropping something lesser if the day is full, or say in the day's notes why it can't be.` });
  }
  return out;
}

/** All checks of a whole plan (or of some of its days: `only`). */
export function validatePlan(days: Day[], ctx: CheckContext, only?: Set<string>): Issue[] {
  const out: Issue[] = [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const want = new Set(ctx.frames.map((f) => f.date));
  // --- Dates: one day per date of the trip, in order ---
  for (const f of ctx.frames) if (!byDate.has(f.date) && (!only || only.has(f.date))) out.push({ code: "missing-day", severity: "hard", date: f.date, message: `${f.date} has no plan.` });
  const seen = new Set<string>();
  for (const d of days) {
    if (!want.has(d.date)) out.push({ code: "outside-trip", severity: "hard", date: d.date, message: `${d.date} isn't a date of the trip.` });
    if (seen.has(d.date)) out.push({ code: "duplicate-date", severity: "hard", date: d.date, message: `${d.date} is planned twice.` });
    seen.add(d.date);
  }
  ctx.frames.forEach((f, fi) => {
    const d = byDate.get(f.date);
    if (!d || (only && !only.has(f.date))) return;
    out.push(...checkDay(d, f, fi, ctx));
  });
  // --- Across days: repeats, must-sees, skipped places ---
  // "Dinner: Konoba Riva" is the restaurant Konoba Riva: compared by that name, not skipped as a generic dinner.
  const plain = days.map((d) => ({ ...d, items: d.items.map((x) => (isMealStop(x) && namedMeal(x.place) ? { ...x, kind: "meal" as const, place: namedMeal(x.place) } : isMealStop(x) ? { ...x, kind: "meal" as const, place: x.place.replace(/^[\p{L}-]+\s+(?=(?:breakfast|brunch|lunch|dinner)\b)/iu, "") } : x)) }));
  const dup = findDuplicates({ days: plain, summary: "", totalEstimatedCost: 0 }, new Set(), ctx.stays);
  for (const x of dup) {
    const d = days[x.again[0]], first = days[x.first[0]];
    if (only && !only.has(d.date)) continue;
    const stop = d.items[x.again[1]];
    out.push({ code: isMealStop(stop) ? "duplicate-restaurant" : "duplicate-place", severity: "repair", date: d.date, item: x.again[1],
      message: `"${stop.place}" is already planned on ${first.date}; replace it with a different place.` });
  }
  // One day trip once: the same ride out of a stay (the ferry to Hvar) on two of its days, by its destination's name
  // or by where it lands (Jelsa is on Hvar too).
  const rides = new Map<string, string>();
  const landed: { stay: number; date: string; at: { lat: number; lng: number } }[] = [];
  for (const f of ctx.frames) {
    const d = byDate.get(f.date);
    if (!d || f.kind !== "full" || !f.sleep) continue;
    const base = ctx.stays[f.sleep.idx], town = lc(short(base.city));
    for (const x of d.items.filter(isRide)) {
      const i = d.items.indexOf(x), dest = lc(short(transferEnds(x.place)?.[1] || ""));
      const s = ctx.located?.get(spotKey(d.date, i));
      if (dest === town || (s && at(base) && km(s, base) < 10)) continue; // the ride back
      const k = `${f.sleep.idx}|${dest}`, first = (dest && rides.get(k)) || landed.find((l) => l.stay === f.sleep!.idx && l.date !== d.date && s && km(l.at, s) < 25)?.date;
      if (!first) { if (dest) rides.set(k, d.date); if (s) landed.push({ stay: f.sleep.idx, date: d.date, at: s }); continue; }
      if (first !== d.date && (!only || only.has(d.date))) out.push({ code: "repeat-day-trip", severity: "repair", date: d.date, item: i, message: `"${x.place}" goes where ${first} already went: a day trip is made once. Plan this day in ${short(base.city)} itself or somewhere else, with places not used on other days.` });
    }
  }
  // ...or by where a full day goes: two full days of one stay spending their time 25+ km out in the same place (Hvar
  // reached by a car ferry written as port stops) are the same trip twice.
  const trips: { stay: number; date: string; at: { lat: number; lng: number } }[] = [];
  for (const f of ctx.frames) {
    const d = byDate.get(f.date);
    if (!d || f.kind !== "full" || !f.sleep) continue;
    const base = ctx.stays[f.sleep.idx];
    if (!at(base)) continue;
    const far = d.items.map((x, i) => ({ x, i, s: ctx.located?.get(spotKey(d.date, i)) })).filter(({ x, s }) => s && !isTransfer(x) && isSubstantive(x) && km(s, base) >= 25);
    if (!far.length) continue;
    const c = { lat: far.reduce((n, p) => n + p.s!.lat, 0) / far.length, lng: far.reduce((n, p) => n + p.s!.lng, 0) / far.length };
    const first = trips.find((t) => t.stay === f.sleep!.idx && km(t.at, c) < 20);
    if (!first) { trips.push({ stay: f.sleep.idx, date: d.date, at: c }); continue; }
    if ((!only || only.has(d.date)) && !out.some((o) => o.code === "repeat-day-trip" && o.date === d.date)) out.push({ code: "repeat-day-trip", severity: "repair", date: d.date, item: far[0].i, message: `"${far[0].x.place}" is where ${first.date} already went: a day trip is made once. Plan this day in ${short(base.city)} itself or somewhere else, with places not used on other days.` });
  }
  // The same restaurant or café on two days, wherever (a konoba from Plitvice doesn't serve dinner in Dubrovnik; the
  // prompt asks for a different place each time).
  const eateries = new Map<string, string>();
  for (const d of days) d.items.forEach((x, i) => {
    const name = isMealStop(x) ? namedMeal(x.place) : CAFE.test(x.place) ? x.place : "";
    if (!name || isHotelStop(x)) return;
    const k = norm(name), first = eateries.get(k);
    if (!first) { eateries.set(k, d.date); return; }
    if (first !== d.date && (!only || only.has(d.date)) && !out.some((o) => o.date === d.date && o.item === i && /duplicate/.test(o.code))) out.push({ code: "duplicate-restaurant", severity: "repair", date: d.date, item: i, message: `"${x.place}" is already the restaurant on ${first}; a different place each time.` });
  });
  // A saved place on two days, whichever town (the stop on the way to Split isn't also seen on the way to Dubrovnik).
  for (const p of ctx.saved) {
    const on = days.filter((d) => visits(d, p.title));
    for (const d of on.slice(1)) if (!only || only.has(d.date)) {
      const i = d.items.findIndex((x) => !isTransfer(x) && names(x.place, p.title));
      if (!out.some((o) => o.date === d.date && o.item === i && /duplicate/.test(o.code))) out.push({ code: "duplicate-place", severity: "repair", date: d.date, item: i, message: `"${d.items[i].place}" is already planned on ${on[0].date}; it belongs on one day only (${ctx.frames.find((f) => f.legs.some((l) => l.stops.some((s) => s.name === p.title)))?.date ? `the travel day it is a stop on the way of, ${ctx.frames.find((f) => f.legs.some((l) => l.stops.some((s) => s.name === p.title)))!.date}` : "whichever fits better"}); replace it here with something else or leave it out.` });
    }
  }
  if (!only) {
    for (const title of ctx.mustSee) {
      if (days.some((d) => visits(d, title))) continue;
      const f = ctx.frames.find((fr) => fr.legs.some((l) => l.stops.some((s) => s.name === title)));
      out.push({ code: "must-see-missing", severity: f ? "repair" : "warn", date: f?.date,
        message: f ? `The must-see "${title}" is meant as a stop on the way today but isn't in the day; add it if the day stays feasible, otherwise say in the notes why it doesn't fit.` : `The must-see "${title}" isn't in the plan.` });
    }
  }
  for (const d of days) {
    if (only && !only.has(d.date)) continue;
    d.items.forEach((x, i) => {
      if (ctx.skip.some((s) => names(x.place, s) && words(s).length)) out.push({ code: "skip-place", severity: "repair", date: d.date, item: i, message: `"${x.place}" is a place the travelers want to skip; remove it.` });
    });
  }
  out.push(...wishIssues(days, ctx, only));
  return out;
}

function checkDay(d: Day, f: Frame, fi: number, ctx: CheckContext): Issue[] {
  const out: Issue[] = [];
  const add = (code: string, severity: Severity, message: string, item?: number) => out.push({ code, severity, date: d.date, item, message });
  const spot = (i: number): Spot | undefined => ctx.located?.get(spotKey(d.date, i));
  const last = fi === ctx.frames.length - 1;
  if (!d.items.length) { add("empty-day", "repair", "The day has no stops at all."); return out; }
  // --- Times and lengths, per group (people apart have their own timelines) ---
  const lines = new Map<string, number[]>();
  d.items.forEach((x, i) => {
    if (!HHMM.test(x.time || "")) add("bad-time", "repair", `"${x.place}" has no valid start time (HH:MM).`, i);
    if (!(Number(x.durationMinutes) > 0)) add("no-duration", "warn", `"${x.place}" has no length; assumed ${defaultMinutes(x)} min.`, i);
    if (x.cost != null && (!Number.isFinite(x.cost) || x.cost < 0)) add("cost-invalid", "repair", `"${x.place}" has an impossible cost (${x.cost}).`, i);
    if (x.cost == null && (x.kind === "sight" || x.kind === "activity" || isMealStop(x) || isTransfer(x)) && !/already booked/i.test(x.description || "") && !isHotelStop(x)) add("cost-unknown", "warn", `"${x.place}" has no price (unknown).`, i);
    if (isDriveTransfer(x) && i < d.items.length - 1) add("needless-transfer", "warn", `"${x.place}" is a drive or walk the map draws itself; folded into the next stop.`, i);
    for (const g of x.who?.length || x.group ? [doers(x)] : [""]) lines.set(g, [...(lines.get(g) || []), i]);
  });
  // Stops everyone does belong to every subgroup's timeline too.
  const together = lines.get("") || [];
  for (const [g, idx] of lines) if (g) lines.set(g, [...idx, ...together].sort((a, b) => a - b));
  for (const idx of lines.values()) {
    // Getting from one place to the next has to fit in the time between them: measured from the last stop whose place
    // is known (a generic lunch in between takes its own time, which is taken off). A ride is a stop of its own.
    const known = (i: number) => !!spot(i) && !isDriveTransfer(d.items[i]);
    let anchor = known(idx[0]) ? idx[0] : -1;
    for (let k = 1; k < idx.length; k++) {
      const a = d.items[idx[k - 1]], b = d.items[idx[k]];
      const ta = minutes(a.time), tb = minutes(b.time);
      if (Number.isNaN(ta) || Number.isNaN(tb)) continue;
      if (tb < ta) { add("order", "repair", `"${b.place}" (${b.time}) comes after "${a.place}" (${a.time}) but starts earlier; put the stops in time order.`, idx[k]); continue; }
      const end = ta + lengthOf(a);
      if (tb - end < -20) { add("overlap", "repair", `"${a.place}" runs until about ${clock(end)} but "${b.place}" starts at ${b.time}; leave time for it (or shorten it).`, idx[k]); continue; }
      if (!known(idx[k])) continue;
      if (anchor >= 0 && !isRide(b)) {
        const p = d.items[anchor], sa = spot(anchor)!, sb = spot(idx[k])!;
        // (A drive the model wrote as a stop in between is the travel itself, not time taken from it.)
        const between = idx.filter((i) => i > anchor && i < idx[k] && !isDriveTransfer(d.items[i])).reduce((n, i) => n + lengthOf(d.items[i]), 0);
        const free = tb - (minutes(p.time) + lengthOf(p)) - between;
        const dist = km(sa, sb), routed = ctx.hops?.[spotKey(d.date, idx[k])];
        const need = needMinutes(dist, b.transport, routed);
        if (need != null && need > 10 && free < need - 15) {
          add("no-time-between", "repair", `"${b.place}" starts at ${b.time}, ${free <= 0 ? "right when" : `only ${hm(free)} after`} "${p.place}" ends${between ? " (counting the stops between)" : ""}, but getting there takes about ${hm(need)} (${dist < 1 ? `${Math.round(dist * 1000)} m` : `${Math.round(dist)} km`}${typeof routed === "number" ? ", routing service" : ""}). Start it later and shift what follows, shorten the stop before, or choose something closer.`, idx[k]);
        }
      }
      anchor = idx[k];
    }
  }
  // The same restaurant twice in a day ("Aroma" for lunch, "Dinner at Aroma").
  const eaten = new Map<string, string>();
  d.items.forEach((x, i) => {
    if (!isMealStop(x)) return;
    const name = lc(namedMeal(x.place) || (/^(breakfast|brunch|lunch|dinner|coffee)\b/i.test(x.place) ? "" : x.place)).trim();
    if (!name) return;
    const first = eaten.get(name);
    if (first) add("same-restaurant", "repair", `"${x.place}" is the same restaurant as "${first}" earlier today; choose a different place.`, i);
    else eaten.set(name, x.place);
  });
  // Meals at their usual times (a "dinner" at 15:00 is a sign the day was squeezed).
  d.items.forEach((x, i) => {
    const t = minutes(x.time), name = x.place.toLowerCase();
    if (!isMealStop(x) || Number.isNaN(t)) return;
    const odd = /\bdinner\b/.test(name) ? t < 17 * 60 : /\blunch\b/.test(name) ? t < 11 * 60 || t > 15 * 60 + 30 : /\bbreakfast\b/.test(name) ? t > 11 * 60 : false;
    if (odd) add("meal-time", "repair", `"${x.place}" at ${x.time} isn't a usual time for it; move it (and what's around it) to a sensible time.`, i);
  });
  // --- Arriving: check in (or leave the bags) before sightseeing in the new town ---
  const arrive = f.legs.length ? ctx.stays[f.legs[f.legs.length - 1].toIdx] : null;
  if (arrive && at(arrive)) {
    const check = d.items.findIndex((x) => isCheckIn(x.place) && !doers(x));
    const inTown = (i: number) => { const s = spot(i); return !!s && km(s, arrive) < 20; };
    if (check >= 0) {
      const before = d.items.slice(0, check).map((x, i) => [x, i] as const).filter(([x, i]) => isSubstantive(x) && inTown(i));
      if (before.length) add("late-check-in", "repair", `They arrive and only check in after "${before[0][0].place}": make checking in (or leaving the bags) the first stop after arriving.`, check);
    }
  }
  // Leaving in the morning: the first stop away from where they woke up can't start before the drive there is done.
  const wake = fi > 0 && ctx.frames[fi - 1].sleep ? ctx.stays[ctx.frames[fi - 1].sleep!.idx] : f.legs[0] ? ctx.stays[f.legs[0].fromIdx] : null;
  if (wake && at(wake)) {
    const first = d.items.findIndex((x, i) => spot(i) && !isDriveTransfer(x) && !doers(x));
    const x = first >= 0 ? d.items[first] : null, s = first >= 0 ? spot(first) : null;
    if (x && s && !isRide(x) && km(wake, s) >= 15 && HHMM.test(x.time || "")) {
      const need = needMinutes(km(wake, s), x.transport, ctx.hops?.[spotKey(d.date, first)]);
      const t = minutes(x.time);
      if (need != null && t - 7 * 60 < need - 15) add("leaves-too-early", "repair", `"${x.place}" starts at ${x.time}, but it's about ${hm(need)} from ${short(wake.city)}, where they wake up${typeof ctx.hops?.[spotKey(d.date, first)] === "number" ? " (routing service)" : ""}: they'd have to leave at ${clock(Math.max(0, t - need))}. Start it later and shift the day.`, first);
    }
  }
  const ends = d.items.map((x) => minutes(x.time) + lengthOf(x)).filter((n) => !Number.isNaN(n));
  if (ends.length && Math.max(...ends) > 23 * 60 + 30) add("late", "warn", `The day runs until about ${clock(Math.max(...ends))}.`);
  // --- Open then? (places from OpenStreetMap with opening hours) ---
  d.items.forEach((x, i) => {
    const s = spot(i);
    if (!s?.hours || !HHMM.test(x.time || "")) return;
    const r = checkHours({ hours: s.hours, date: d.date, time: x.time, minutes: lengthOf(x), lat: s.lat, lng: s.lng, cc: s.cc || "" } as any);
    if (["closed", "closed-all-day", "closes-early"].includes(r.status)) add("closed-then", "repair", `"${x.place}" at ${x.time}: ${r.text}. Move it to when it's open (and move what's around it), or replace it with a similar place that is open.`, i);
    else if (r.status === "opens-later") add("opens-later", "warn", `"${x.place}" at ${x.time}: ${r.text}.`, i);
  });
  // --- Departure times nobody looked up ---
  d.items.forEach((x, i) => {
    const times = unverifiedTimes(x, ctx.known);
    if (times.length) add("unverified-schedule", "repair", `"${x.place}" states departure time(s) ${times.join(", ")} that weren't in any timetable or research given; don't state departure times, say to check the current timetable and plan with a buffer.`, i);
  });
  // --- The car in town, when they'd rather not drive there ---
  if (ctx.getAround === "mixed" || ctx.getAround === "transit") {
    const base = f.sleep ? ctx.stays[f.sleep.idx] : null;
    d.items.forEach((x, i) => {
      if (isTransfer(x) || !CAR.test(x.transport || "") || WALK.test(x.transport || "") || TRANSIT.test(x.transport || "")) return;
      if (/^\s*(walk to the car;\s*)?drive from\b/i.test(x.transport || "")) return; // the drive into town, written from the frame
      const s = spot(i), prev = i > 0 ? spot(i - 1) : null;
      if (!s || !prev || !base || !at(base) || km(s, base) > 12 || km(prev, s) > 12) return;
      add("car-in-town", "repair", `"${x.place}" is reached by car (${x.transport}) although it's in town: they leave the car parked in town and walk or take public transport; name the line and the stop, or the walk.`, i);
    });
  }
  // --- How full the day is ---
  const wayStops = f.legs.flatMap((l) => l.stops.map((s) => s.name));
  const substantive = d.items.map((x, i) => [x, i] as const).filter(([x]) => isSubstantive(x) && !doers(x));
  const extra = substantive.filter(([x]) => !wayStops.some((w) => names(x.place, w)));
  const size = DAY_SIZE[ctx.pace];
  if (f.kind === "travel" && f.legs.length) {
    const drive = f.legs.map(legHours).reduce<number | null>((n, h) => (n == null || h == null ? null : n + h), 0);
    // After a long drive only one light thing, unless they arrive early in the afternoon anyway.
    const arrivals = arrive && at(arrive) ? d.items.map((x, i) => (spot(i) && km(spot(i)!, arrive) < 20 ? minutes(x.time) : NaN)).filter((n) => !Number.isNaN(n)) : [];
    const early = arrivals.length > 0 && Math.min(...arrivals) <= 14 * 60;
    const most = Math.max(0, size.travel[1] - (!early && drive != null && drive >= 4 ? 1 : 0));
    if (extra.length > most) add("travel-day-heavy", "repair", `A travel day${drive != null ? ` with about ${hm(Math.round(drive * 60))} of driving` : ""} should have at most ${most} light thing${most === 1 ? "" : "s"} besides the stops on the way; it has ${extra.length} (${extra.map(([x]) => x.place).join("; ")}). Keep the best${most ? "" : " none"} and move the rest to a full day or leave them out.`);
    // Day trips don't belong on travel days: a sight far from both towns and off the road between them.
    for (const leg of f.legs) {
      const a = ctx.stays[leg.fromIdx], b = ctx.stays[leg.toIdx];
      if (!at(a) || !at(b)) continue;
      for (const [x, i] of extra) {
        const s = spot(i);
        if (!s || s.how === "near") continue;
        const far = Math.min(km(a, s), km(b, s)) > DAY_TRIP_MINUTES * 0.9; // ~0.9 km a minute of driving
        if (far && detourKm(a, s, b) > 30) add("day-trip-on-travel-day", "repair", `"${x.place}" is about ${Math.round(Math.min(km(a, s), km(b, s)))} km from ${short(leg.from)} and ${short(leg.to)} and off the road between them: a day trip, which belongs on a full day.`, i);
      }
    }
  } else if (f.kind === "full") {
    if (!substantive.length) add("full-day-empty", "repair", `A full day with nothing to see or do: plan about ${size.full[0]}-${size.full[1]} real sights or activities for it, with lunch and dinner.`);
    else if (substantive.length < size.full[0]) add("full-day-thin", "warn", `A full day with ${substantive.length} sight${substantive.length === 1 ? "" : "s"} or activit${substantive.length === 1 ? "y" : "ies"} (about ${size.full[0]}-${size.full[1]} at their pace, unless one fills the day).`);
    if (substantive.length > size.full[1] + 1) add("full-day-packed", "warn", `A full day with ${substantive.length} sights or activities (about ${size.full[0]}-${size.full[1]} at their pace).`);
  }
  // --- Lunch and dinner on a full day ---
  if (f.kind === "full" && d.items.length >= 2 && !last) {
    const at = (x: ItineraryItem) => minutes(x.time);
    const meals = d.items.filter((x) => isMealStop(x) && !Number.isNaN(at(x)));
    if (!meals.some((x) => at(x) >= 11 * 60 && at(x) <= 15 * 60 + 30)) add("meal-missing", "repair", `No lunch on this day; add one between 12:00 and 14:00 (a real place from the lists, or "Lunch near <a named spot>").`);
    if (!meals.some((x) => at(x) >= 17 * 60)) add("meal-missing", "repair", `No dinner on this day; add one from about 18:30 (a real place from the lists, or "Dinner near <a named spot>").`);
  }
  // --- A travel day goes one way: the arrival town's stops after the departure town's ---
  if (f.kind === "travel" && f.legs.length) {
    const from = ctx.stays[f.legs[0].fromIdx], to = ctx.stays[f.legs[f.legs.length - 1].toIdx];
    if (from && to && at(from) && at(to) && km(from, to) > 60) {
      const placed = d.items.map((x, i) => ({ x, i, s: spot(i) })).filter(({ x, s }) => s && s.how !== "near" && !isTransfer(x) && !doers(x));
      const firstThere = placed.find(({ s }) => km(s!, to) < 30);
      const laterHere = firstThere ? placed.find(({ i, s }) => i > firstThere.i && km(s!, from) < 30) : undefined;
      if (firstThere && laterHere) add("order", "repair", `"${firstThere.x.place}" is in ${short(to.city)}, where the day ends, but comes before "${laterHere.x.place}" in ${short(from.city)}; put the stops in the order of the day's travel.`, firstThere.i);
    }
  }
  // --- Ends where they sleep ---
  const sleep = f.sleep ? ctx.stays[f.sleep.idx] : null;
  if (!last && sleep && at(sleep)) {
    const located = d.items.map((x, i) => [x, i] as const).filter(([x, i]) => !doers(x) && !isTransfer(x) && spot(i) && spot(i)!.how !== "near");
    const end = located.at(-1);
    // (Only when nothing whose place isn't known comes after it: that may well be back in town.)
    const after = end ? d.items.slice(end[1] + 1).some((x) => !isTransfer(x) && !isMealStop(x)) : false;
    if (end && !after && km(sleep, spot(end[1])!) > 60) add("wrong-base", "repair", `The day ends at "${end[0].place}", ${Math.round(km(sleep, spot(end[1])!))} km from ${short(sleep.city)}, where they sleep tonight; end the day nearer to there (or say how they get back).`);
  }
  // --- Budget ---
  const cost = d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0);
  if (ctx.dailyBudget > 0 && cost > ctx.dailyBudget * 1.1) add("over-budget", "warn", `The day costs about ${Math.round(cost)}, over the daily budget of ${Math.round(ctx.dailyBudget)}.`);
  return out;
}

/** How bad a day's problems are, to tell whether a rewrite made it better. */
export const score = (issues: Issue[]) => issues.reduce((n, x) => n + (x.severity === "hard" ? 100 : x.severity === "repair" ? 10 : 1), 0);

// ---- Fixes code can make by itself (no model) ----

/**
 * Tidies days in place before checking: dates outside the trip and second copies of a date go, stops without a length
 * get a default one, times are normalised ("9:00" → "09:00"). Returns what it changed, for the notes.
 */
export function tidyDays(days: Day[], ctx: Pick<CheckContext, "frames">) {
  const notes: string[] = [];
  const want = new Set(ctx.frames.map((f) => f.date));
  const seen = new Set<string>();
  const kept = days.filter((d) => {
    if (!want.has(d.date)) { notes.push(`Dropped a day dated ${d.date}, which isn't in the trip.`); return false; }
    if (seen.has(d.date)) { notes.push(`Dropped a second copy of ${d.date}.`); return false; }
    seen.add(d.date); return true;
  }).sort((a, b) => a.date.localeCompare(b.date));
  for (const d of kept) for (const x of d.items) {
    const m = /^(\d{1,2}):(\d{2})/.exec(x.time || "");
    if (m) x.time = `${m[1].padStart(2, "0")}:${m[2]}`;
    if (!(Number(x.durationMinutes) > 0)) x.durationMinutes = defaultMinutes(x);
    else x.durationMinutes = Math.round(Number(x.durationMinutes));
  }
  return { days: kept, notes };
}

/**
 * Stops that stand for getting somewhere rather than being somewhere: a stop that is just the name of a town they
 * stay in ("Budapest, Hungary" for two hours, "Zagreb (Hotel)" at the start), not a saved place, becomes a drive
 * transfer (folded into the next stop); checking in or out on a day they don't change hotels goes. Returns notes.
 */
export function dropStandIns(days: Day[], ctx: Pick<CheckContext, "frames" | "stays" | "saved">) {
  const notes: string[] = [];
  const towns = new Set(ctx.stays.map((s) => lc(short(s.city))).filter(Boolean));
  const savedNames = new Set(ctx.saved.flatMap((p) => [lc(p.title), lc(short(p.title))]));
  const SUFFIX = /\s+(city cent(?:re|er)|cent(?:re|er)|old town|downtown|city|town|hotel|arrival|stop)$/i;
  for (const d of days) {
    const f = ctx.frames.find((x) => x.date === d.date);
    // The day's drives, in minutes: a stop as long as one of them, named after the town, is that drive.
    const drives = (f?.legs || []).flatMap((l) => (l.segments.length ? l.segments.map((s) => s.drive?.hours) : [l.direct?.hours])).filter((h): h is number => typeof h === "number").map((h) => h * 60);
    for (let i = d.items.length - 1; i >= 0; i--) {
      const x = d.items[i];
      if (f?.kind === "full" && (isCheckIn(x.place) || isCheckOut(x.place)) && !/\b(bag|luggage)/i.test(x.place)) {
        d.items.splice(i, 1); notes.push(`${d.date}: left out "${x.place}" (no change of hotel that day).`); continue;
      }
      // A drive written as the day's last stop ("Lake Balaton → Zagreb (car)" after dinner): the frame's drive, drawn by the map.
      if (isDriveTransfer(x) && i === d.items.length - 1 && f?.legs.length && i > 0) { d.items.splice(i, 1); notes.push(`${d.date}: left out "${x.place}" at the end (the drive is drawn by the map).`); continue; }
      if (isTransfer(x) || isMealStop(x) || isHotelStop(x)) continue;
      const n = lc(short(placeOf(x.place.replace(/^(?:arrival|arrive|arriving|back|return(?:ing)?)\s+(?:at|in|to|home to)\s+/i, ""))));
      const next = d.items.slice(i + 1).find((y) => !isTransfer(y));
      const drive = /^(drive|driving|transfer|travel|journey|road trip|walk|walking|stroll)\s+(to|towards|from|back|over to)\b/i.test(x.place);
      const town = towns.has(n) && !savedNames.has(lc(x.place)) && !savedNames.has(n);
      const asLongAsDrive = towns.has(n.replace(SUFFIX, "")) && drives.some((m) => Math.abs(m - (Number(x.durationMinutes) || 0)) <= Math.max(15, m * 0.2));
      if ((drive || town || asLongAsDrive) && next) { x.kind = "transfer"; notes.push(`${d.date}: "${x.place}" is the way to ${drive ? "the next stop" : short(x.place)}, not a stop; folded into "${next.place}".`); }
      // The town they drive to as the day's last stop (their home address at the end): the drive itself, drawn by the map.
      else if ((drive || town || /^(?:arrival|arrive|arriving|back|return(?:ing)?)\b.*\bhome\b|^(?:arrival|home)$/i.test(x.place)) && !next && f?.legs.length) { d.items.splice(i, 1); notes.push(`${d.date}: left out "${x.place}" (the drive there is drawn by the map).`); }
    }
  }
  return notes;
}

const toMinutes = (t: string) => minutes(t);

/**
 * Makes a day's timeline feasible where code can: a stop that starts before the one before it ends plus the time to
 * get there (or before the drive from where they woke up can be done) moves to when it can start; what follows moves
 * only if it then starts too early itself (the day's gaps take up the rest). Nothing moves to after 21:00: that is
 * left for the model to rethink. Returns what moved, for the notes.
 */
export function shiftTimes(days: Day[], ctx: CheckContext) {
  const notes: string[] = [];
  const spot = (d: Day, i: number) => ctx.located?.get(spotKey(d.date, i));
  const lines = (items: ItineraryItem[]) => {
    const map = new Map<string, number[]>();
    items.forEach((x, i) => { for (const g of x.who?.length || x.group ? [doers(x)] : [""]) map.set(g, [...(map.get(g) || []), i]); });
    const together = map.get("") || [];
    for (const [g, idx] of map) if (g) map.set(g, [...idx, ...together].sort((a, b) => a - b));
    return [...map.values()];
  };
  for (const d of days) {
    const fi = ctx.frames.findIndex((f) => f.date === d.date);
    if (fi < 0) continue;
    const f = ctx.frames[fi];
    const wake = fi > 0 && ctx.frames[fi - 1].sleep ? ctx.stays[ctx.frames[fi - 1].sleep!.idx] : f.legs[0] ? ctx.stays[f.legs[0].fromIdx] : null;
    for (const idx of lines(d.items)) {
      // travelled: a drive the model wrote as a stop lies between the anchor and the next stop, so the way there is done.
      let anchor: { end: number; at: { lat: number; lng: number }; place: string; travelled?: boolean } | null = wake && at(wake) ? { end: 7 * 60, at: wake, place: short(wake.city) } : null;
      for (const i of idx) {
        const x = d.items[i], t = toMinutes(x.time);
        if (Number.isNaN(t)) continue;
        // Never past 21:00, nor past the ride that leaves after it (the ferry back): that is for the model to rethink.
        const ride = idx.filter((j) => j > i).map((j) => d.items[j]).find((y) => isRide(y) && !Number.isNaN(toMinutes(y.time)));
        const latest = Math.min(21 * 60, ride ? toMinutes(ride.time) - defaultMinutes(x) : Infinity);
        let start = t;
        const s = spot(d, i);
        if (anchor && s && !isDriveTransfer(x) && !isRide(x)) {
          const dist = km(anchor.at, s), need = anchor.travelled ? 0 : dist >= 0.08 ? needMinutes(dist, x.transport, ctx.hops?.[spotKey(d.date, i)]) : 0;
          // Overlapping the stop before counts too (no slack then); a short way there gets 10 minutes' slack.
          const earliest = need == null ? anchor.end : anchor.end + (need > 10 ? need - 10 : 0);
          if (start < earliest && earliest <= latest) {
            notes.push(`${d.date}: "${x.place}" moved from ${clock(start)} to ${clock(earliest)} (${need != null && need > 10 ? `getting there from ${anchor.place} takes about ${hm(need)}` : `"${anchor.place}" runs until ${clock(anchor.end)}`}).`);
            start = earliest;
          }
        } else if (anchor && start < anchor.end - 20 && anchor.end <= latest && !isDriveTransfer(x)) {
          // No place known, but it can't start before the stop before it ends.
          start = anchor.end;
        }
        if (start !== t) x.time = clock(start);
        const len = Number(x.durationMinutes) > 0 ? Number(x.durationMinutes) : defaultMinutes(x);
        if (s && !isDriveTransfer(x)) anchor = { end: start + len, at: s, place: x.place };
        else if (anchor) anchor = { ...anchor, end: Math.max(anchor.end, start + len), travelled: anchor.travelled || isDriveTransfer(x) };
      }
    }
  }
  return notes;
}

/**
 * Takes out transfers the map draws by itself (a drive, a taxi, a walk: "Hotel → Schönbrunn (car)", "Vienna →
 * Bratislava (car)", "Fort → Lunch"); the next stop keeps how to get there. Rides stay (boats, trains, lifts: points
 * the route must pass). A drive that is the last stop of its day stays too (nothing follows to carry it). Run after
 * the checks, which number the stops.
 */
export function foldTransfers(days: Day[]) {
  const notes: string[] = [];
  for (const d of days) {
    for (let i = d.items.length - 2; i >= 0; i--) {
      const x = d.items[i];
      if (!isDriveTransfer(x)) continue;
      const next = d.items.slice(i + 1).find((y) => doers(y) === doers(x) || !doers(y));
      if (!next || isTransfer(next)) continue;
      const junk = /^(n\/a|-|none|start of (the )?day|walk to (the )?car)$/i;
      const how = (x.transport && !junk.test(x.transport.trim()) ? x.transport : "").trim();
      const own = (next.transport || "").trim();
      const drive = how && !/\b(walk|on foot)\b/i.test(how) && Number(x.durationMinutes) > 0 && !/\d+\s*(min|h)\b/i.test(how) ? `${how}, ${hm(Number(x.durationMinutes))}` : how;
      next.transport = [drive, own && own !== drive && !junk.test(own) ? own : ""].filter(Boolean).join("; ") || own || drive;
      if (x.cost) next.cost = (Number(next.cost) || 0) + Number(x.cost);
      d.items.splice(i, 1);
      notes.push(`${d.date}: "${x.place}" is part of getting to "${next.place}".`);
    }
  }
  return notes;
}

/** A place planned a little before it opens moves to its opening time, when that still leaves half an hour before the next stop. */
/** Meals the model named wrongly: a "lunch" in the evening is dinner (or, with dinner soon after, nothing); one in
 *  the morning is a coffee; the same restaurant twice in a day keeps the first visit, the second becomes a meal
 *  nearby (for the model to name, or not). Returns notes. */
export function quickFixMeals(days: Day[]) {
  const notes: string[] = [];
  const LUNCH = /^(?:[\p{L}-]+\s+)?lunch\b/iu;
  for (const d of days) {
    for (let i = d.items.length - 1; i >= 0; i--) {
      const x = d.items[i];
      if (!isMealStop(x) || isHotelStop(x) || !LUNCH.test(x.place)) continue;
      const t = minutes(x.time);
      if (Number.isNaN(t)) continue;
      const dinner = d.items.find((y) => y !== x && isMealStop(y) && minutes(y.time) > t && /\b(dinner|supper)\b/i.test(y.place));
      if (t >= 16 * 60 + 30 && dinner && minutes(dinner.time) - t <= 150) {
        notes.push(`${d.date}: left out "${x.place}" at ${x.time} (dinner follows at ${dinner.time}).`);
        d.items.splice(i, 1);
      } else if (t >= 16 * 60 + 30 && !dinner) {
        const was = x.place; x.place = x.place.replace(/\blunch\b/i, (m) => (m[0] === "L" ? "Dinner" : "dinner"));
        notes.push(`${d.date}: "${was}" at ${x.time} is dinner; renamed.`);
      } else if (t < 11 * 60 && !namedMeal(x.place)) {
        const was = x.place; x.place = x.place.replace(/\blunch\b/i, (m) => (m[0] === "L" ? "Coffee" : "coffee"));
        notes.push(`${d.date}: "${was}" at ${x.time} is a coffee, not lunch; renamed.`);
      }
    }
    const meals = d.items.filter((x) => isMealStop(x) && !isHotelStop(x));
    const seen = new Map<string, ItineraryItem>();
    for (const x of meals) {
      const name = namedMeal(x.place);
      if (!name) continue;
      const k = norm(name), first = seen.get(k);
      if (!first) { seen.set(k, x); continue; }
      const was = x.place, word = minutes(x.time) >= 16 * 60 ? "Dinner" : minutes(x.time) >= 11 * 60 ? "Lunch" : "Breakfast";
      x.place = `${word} near ${name}`; x.kind = "meal";
      notes.push(`${d.date}: "${was}" was the second visit to the same restaurant that day; made it "${x.place}".`);
    }
  }
  return notes;
}

/** The same place twice in one day (Ston at 9:00 and again at 11:30): the second goes, with any ride to or from it.
 *  A stop given more than five hours that isn't a park, a hike, an island or a spa is cut to three. Returns notes. */
export function dropSameDayRepeats(days: Day[]) {
  const notes: string[] = [];
  const LONG_OK = /\b(park|hike|hiking|trail|trek|national|island|beach|spa|bath|baths|thermal|lake|lakes|safari|ski|mountain|gorge|canyon|valley|falls|waterfall|garden|gardens|zoo|theme)\b/i;
  for (const d of days) {
    const seen = new Set<string>();
    for (let i = 0; i < d.items.length; i++) {
      const x = d.items[i];
      if (isTransfer(x) || isMealStop(x) || isHotelStop(x)) continue;
      const k = norm(placeOf(x.place));
      if (!k) continue;
      if (seen.has(k)) {
        notes.push(`${d.date}: left out the second "${x.place}" of the day.`);
        d.items.splice(i, 1);
        // The ride that brought them there, and the one back, go with it.
        const to = (y: ItineraryItem | undefined) => y && isRide(y) && names(transferEnds(y.place)?.[1] || "", x.place);
        const from = (y: ItineraryItem | undefined) => y && isRide(y) && names(transferEnds(y.place)?.[0] || "", x.place);
        if (from(d.items[i])) d.items.splice(i, 1);
        if (to(d.items[i - 1])) { d.items.splice(i - 1, 1); i--; }
        i--;
        continue;
      }
      seen.add(k);
      if (Number(x.durationMinutes) > 300 && !LONG_OK.test(x.place) && !doers(x)) {
        notes.push(`${d.date}: "${x.place}" was given ${hm(Number(x.durationMinutes))}; cut to 3 h 00 min.`);
        x.durationMinutes = 180;
      }
    }
  }
  return notes;
}

export function quickFixHours(days: Day[], ctx: CheckContext) {
  const notes: string[] = [];
  for (const d of days) d.items.forEach((x, i) => {
    const s = ctx.located?.get(spotKey(d.date, i));
    if (!s?.hours || !HHMM.test(x.time || "")) return;
    const r = checkHours({ hours: s.hours, date: d.date, time: x.time, minutes: lengthOf(x), lat: s.lat, lng: s.lng, cc: s.cc || "" } as any);
    const opens = r.status === "opens-later" ? minutes(r.opens || "") : NaN;
    if (Number.isNaN(opens) || opens <= minutes(x.time)) return;
    const next = d.items.slice(i + 1).find((y) => doers(y) === doers(x) || !doers(y));
    if (next && minutes(next.time) - opens < 30) return;
    notes.push(`${d.date}: "${x.place}" moved from ${x.time} to ${clock(opens)}, when it opens.`);
    x.time = clock(opens);
  });
  return notes;
}

/** Events and holidays that can't apply: dated outside the trip, or in a town they visit, but not on that date. */
export function filterEvents<T extends { date: string; name: string; where?: string }>(events: T[], ctx: Pick<CheckContext, "frames" | "stays">) {
  const first = ctx.frames[0]?.date || "", last = ctx.frames.at(-1)?.date || "";
  const dropped: string[] = [];
  const kept = events.filter((e) => {
    const [from, to = from] = String(e.date || "").split("..");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return true; // no exact date: kept as given
    if (to < first || from > last) { dropped.push(`${e.name} (${e.date}): outside the trip`); return false; }
    const town = ctx.stays.find((s) => Number(s.nights) > 0 && e.where && words(e.where).some((w) => words(short(s.city)).includes(w)));
    if (town) {
      const end = new Date(Date.parse(town.start) + Number(town.nights) * 86_400_000).toISOString().slice(0, 10);
      if (to < town.start || from > end) { dropped.push(`${e.name} (${e.date}): they're in ${short(town.city)} only ${town.start} to ${end}`); return false; }
    }
    return true;
  });
  return { kept, dropped };
}
