// The trip's fixed frame, worked out in code before any model is asked: every date, whether it's a travel day or a
// full day, where they sleep that night, the legs between stays with real driving times (a routing service, with the
// must-sees on the way as waypoints), the holidays of the country they're actually in that day, and the local currency.
// The model plans inside this frame; validate.ts checks the result against it.
import type { Place } from "../../../shared/types";
import { km } from "../../../shared/route";
import { addDays } from "../../config";
import type { Trip } from "../types";

export interface Point { name: string; lat?: number; lng?: number }
/** A routed drive: hours and km, null when no road route exists, undefined when it couldn't be checked. */
export type Drive = { hours: number; km: number } | null | undefined;
export type RouteFn = (a: Point, b: Point) => Promise<Drive>;

export interface WayStop extends Point {
  /** A full day of the stay before or after that could take it as a day trip instead, with the km from that stay. */
  alternative?: { city: string; km: number };
}

export interface Leg {
  fromIdx: number; toIdx: number; from: string; to: string;
  /** How they travel (the stay's chosen mode), "" when not chosen. */
  mode: string;
  /** The direct route between the stays (from the server's road check). */
  direct?: Drive;
  stops: WayStop[];
  /** Driving segments in order, through the stops (routed in planner.ts). */
  segments: { from: string; to: string; drive: Drive }[];
}

export interface Frame {
  date: string;
  weekday: string;
  /** A day with travel between stays, or a full day at one stay. */
  kind: "travel" | "full";
  /** The stay they sleep at that night; null on the last day. */
  sleep: { idx: number; city: string; hotel?: string } | null;
  legs: Leg[];
  /** Day trips the travelers planned from this stay (only offered on full days). */
  dayTrips: string[];
  /** Official holidays in the country (and region) they're in that day. */
  holidays: string[];
  daylight?: string;
  /** Country codes they're in that day. */
  countries: string[];
}

const ROAD = new Set(["car", "bus", "bike", ""]);
const lc = (s: unknown) => String(s ?? "").toLowerCase();
const at = (p?: { lat?: number; lng?: number } | null): p is { lat: number; lng: number } => typeof p?.lat === "number" && typeof p?.lng === "number";
export const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

/** The stay they sleep at on a date (a stay with nights covering it), or -1. */
export function sleepIndex(trip: Trip, date: string) {
  return trip.stays.findIndex((s) => Number(s.nights) > 0 && s.start && date >= s.start && date < addDays(s.start, Number(s.nights)));
}

/** The first and last date of the trip. */
export function tripDates(trip: Trip) {
  const first = trip.stays.map((s) => s.start).filter(Boolean).sort()[0] || "";
  const last = trip.stays.reduce((d, s) => { const end = s.start ? addDays(s.start, Number(s.nights) || 0) : ""; return end > d ? end : d; }, first);
  const out: string[] = [];
  for (let d = first; d && d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Saved must-sees that are stops on the way between two stays (the travelers chose "on the way", or the route
 *  check found them right on it), by the index of the stay the leg arrives at. */
function wayStops(trip: Trip, places: Place[]) {
  const out = new Map<number, WayStop[]>();
  for (const title of trip.mustSee || []) {
    const r = trip.mustSeeRoute?.[title];
    if (!r || !(r.how === "way" || (!r.how && r.onWay)) || !r.leg) continue;
    const to = trip.stays.findIndex((s, i) => i > 0 && lc(s.city) === lc(r.leg!.to) && lc(trip.stays[i - 1].city) === lc(r.leg!.from));
    if (to < 0) continue;
    const p = places.find((x) => x.title === title);
    out.set(to, [...(out.get(to) || []), { name: title, lat: p?.lat, lng: p?.lng }]);
  }
  return out;
}

export function buildFrames(trip: Trip, places: Place[]): Frame[] {
  const stops = wayStops(trip, places);
  const dates = tripDates(trip);
  return dates.map((date) => {
    const legs: Leg[] = [];
    trip.stays.forEach((s, i) => {
      if (i === 0 || s.start !== date) return;
      const prev = trip.stays[i - 1];
      const mode = s.travel || "";
      const list = (stops.get(i) || []).slice();
      // Order the stops by how far along the leg they are.
      if (at(prev)) list.sort((a, b) => (at(a) && at(b) ? km(prev, a) - km(prev, b) : 0));
      legs.push({ fromIdx: i - 1, toIdx: i, from: prev.city, to: s.city, mode, direct: trip.drives?.[i], stops: list, segments: [] });
    });
    const si = sleepIndex(trip, date);
    const stay = si >= 0 ? trip.stays[si] : null;
    const countries = [...new Set([stay?.cc, ...legs.flatMap((l) => [trip.stays[l.fromIdx].cc, trip.stays[l.toIdx].cc])].filter((c): c is string => !!c).map((c) => c.toUpperCase()))];
    const holidays = (trip.holidays || []).filter((h) => h.date === date && countries.includes(h.cc.toUpperCase()))
      .map((h) => `${h.name}${h.localName && h.localName !== h.name ? ` (${h.localName})` : ""}, ${h.cc}${h.counties?.length ? ` - regional only: ${h.counties.join(", ")}` : " - nationwide"}`);
    const full = !legs.length && !!stay;
    return {
      date, weekday: weekdayOf(date), kind: full ? "full" : "travel",
      sleep: stay ? { idx: si, city: stay.city, hotel: stay.hotel || undefined } : null,
      legs, dayTrips: full ? (stay!.dayTrips || []).map((t) => t.place).filter(Boolean) : [],
      holidays, daylight: si >= 0 ? trip.daylight?.[si] : undefined, countries,
    } satisfies Frame;
  });
}

/** Routes each road leg through its stops (cached by the routing service), and finds a nearby full-day stay for
 *  stops that make the travel day long. */
export async function routeFrames(frames: Frame[], trip: Trip, route: RouteFn) {
  for (const f of frames) for (const leg of f.legs) {
    if (!ROAD.has(leg.mode)) continue;
    const a = trip.stays[leg.fromIdx], b = trip.stays[leg.toIdx];
    const points: Point[] = [{ name: a.city, lat: a.lat, lng: a.lng }, ...leg.stops, { name: b.city, lat: b.lat, lng: b.lng }];
    leg.segments = [];
    for (let i = 1; i < points.length; i++) {
      const drive = at(points[i - 1]) && at(points[i]) ? await route(points[i - 1], points[i]) : undefined;
      leg.segments.push({ from: points[i - 1].name, to: points[i].name, drive });
    }
    for (const s of leg.stops) {
      if (!at(s)) continue;
      // The stay before or after with full days, if the stop is close enough to make a day trip from there.
      const options = [leg.fromIdx, leg.toIdx].map((i) => trip.stays[i])
        .filter((x) => at(x) && Number(x.nights) >= 2).map((x) => ({ city: x.city, km: Math.round(km(x as { lat: number; lng: number }, s)) }))
        .sort((p, q) => p.km - q.km);
      if (options[0] && options[0].km <= 100) s.alternative = options[0];
    }
  }
}

/** Driving hours of a leg through its stops: the sum of the routed segments, else the direct route; null if unknown. */
export function legHours(leg: Leg): number | null {
  if (leg.segments.length && leg.segments.every((s) => s.drive)) return leg.segments.reduce((n, s) => n + s.drive!.hours, 0);
  if (!leg.stops.length && leg.direct) return leg.direct.hours;
  return null;
}

/** Minutes a stop on the way takes by default (a walk around, a viewpoint); lunch is counted separately. */
export const STOP_MINUTES = 75;

/** A travel day's rough length in hours: driving plus 15% for breaks and parking, the stops, lunch and an hour to
 *  check out and in. Null when the driving time isn't known. */
export function travelLoad(f: Frame) {
  if (!f.legs.length) return null;
  const hours = f.legs.map(legHours);
  if (hours.some((h) => h == null)) return null;
  const drive = (hours as number[]).reduce((n, h) => n + h, 0);
  const stops = f.legs.reduce((n, l) => n + l.stops.length, 0);
  return { drive, total: drive * 1.15 + (stops * STOP_MINUTES) / 60 + 1 + 1 };
}

/** Over this many hours a travel day can't be done as asked; above LONG it is long but possible. */
export const TOO_LONG_HOURS = 11.5;
export const LONG_HOURS = 9.5;

// ---- Local currency ----

/** The currency of each country code (the ones a trip is likely to pass through; anything else: none). */
const CURRENCY: Record<string, string> = {
  AT: "EUR", BE: "EUR", HR: "EUR", CY: "EUR", EE: "EUR", FI: "EUR", FR: "EUR", DE: "EUR", GR: "EUR", IE: "EUR", IT: "EUR",
  LV: "EUR", LT: "EUR", LU: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SK: "EUR", SI: "EUR", ES: "EUR", MC: "EUR", SM: "EUR",
  VA: "EUR", AD: "EUR", ME: "EUR", XK: "EUR", CZ: "CZK", HU: "HUF", PL: "PLN", RO: "RON", BG: "BGN", DK: "DKK", SE: "SEK",
  NO: "NOK", IS: "ISK", CH: "CHF", LI: "CHF", GB: "GBP", RS: "RSD", BA: "BAM", AL: "ALL", MK: "MKD", TR: "TRY", UA: "UAH",
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", PE: "PEN", CO: "COP", JP: "JPY", KR: "KRW", CN: "CNY",
  HK: "HKD", TW: "TWD", SG: "SGD", TH: "THB", VN: "VND", ID: "IDR", MY: "MYR", PH: "PHP", IN: "INR", AE: "AED", AU: "AUD",
  NZ: "NZD", ZA: "ZAR", MA: "MAD", EG: "EGP", IL: "ILS", GE: "GEL",
};

/** The currency of the country where they spend the most nights; undefined if not known. */
export function localCurrency(trip: Trip) {
  const nights = new Map<string, number>();
  for (const s of trip.stays) {
    const cur = CURRENCY[String(s.cc || "").toUpperCase()];
    if (cur) nights.set(cur, (nights.get(cur) || 0) + (Number(s.nights) || 0));
  }
  return [...nights].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// ---- Research findings ----

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The dates a line of text names ("2027-09-16", "September 16, 2027", "16 September 2027", "Sept 16"), in the trip's year. */
export function datesIn(text: string, year: number): string[] {
  const out = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  for (const m of text.matchAll(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"))) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
    if (mi >= 0 && Number(m[2]) <= 31) out.add(`${m[3] || year}-${pad(mi + 1)}-${pad(Number(m[2]))}`);
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}(?:\\s+(\\d{4}))?\\b`, "gi"))) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3)));
    if (mi >= 0 && Number(m[1]) <= 31) out.add(`${m[3] || year}-${pad(mi + 1)}-${pad(Number(m[1]))}`);
  }
  return [...out];
}

/**
 * Research findings with a warning after any line whose dates fall outside the trip, or outside the stay in the town
 * it's about ("a concert on 16 September" in a town they leave on the 1st): the model is told not to plan with it.
 * The findings themselves are left as they are.
 */
export function annotateResearch(notes: string, trip: Trip) {
  const dates = tripDates(trip);
  if (!notes || !dates.length) return notes;
  const first = dates[0], last = dates[dates.length - 1], year = Number(first.slice(0, 4));
  const stays = trip.stays.filter((s) => Number(s.nights) > 0 && s.start);
  return notes.split("\n").map((line) => {
    const named = datesIn(line, year);
    if (!named.length) return line;
    const text = lc(line);
    const stay = stays.find((s) => { const w = lc(s.city).split(",")[0].trim(); return w.length > 2 && text.includes(w); });
    const end = stay ? addDays(stay.start, Number(stay.nights)) : "";
    const outside = named.filter((d) => d < first || d > last || (stay && (d < stay.start || d > end)));
    if (!outside.length) return line;
    const why = stay ? `outside the ${stay.city.split(",")[0]} stay (${stay.start} to ${end})` : `outside the trip (${first} to ${last})`;
    return `${line}\n  (Checked in code: ${outside.join(", ")} is ${why}; don't plan with it.)`;
  }).join("\n");
}

/** Where a place is on the line between two points: km of detour it adds. */
export const detourKm = (a: { lat: number; lng: number }, p: { lat: number; lng: number }, b: { lat: number; lng: number }) => km(a, p) + km(p, b) - km(a, b);
