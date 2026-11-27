// GET /api/trips: the saved trips as cards for the trip picker (Your trips): where and when, how long, who, whether
// there's a plan, and a rough route to draw (the stays where they were set on the map or as looked up, the plan's stops
// as dots). Stays never looked up on this computer (a trip from a sync folder) are looked up when the cards are asked for.
import fs from "node:fs";
import path from "node:path";
import type { TripCard } from "../../shared/types";
import { SAVES_DIR } from "../config";
import { geoCache, geocodeBatch } from "../geo/geocode";

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Where each looked-up name is: the first cached answer for it (any countries, any "near"), by the name alone. */
export function placesByName() {
  const out = new Map<string, { lat: number; lng: number; cc?: string; country?: string }>();
  for (const [k, v] of Object.entries(geoCache.data)) {
    if (!v || typeof v !== "object" || typeof (v as { lat?: unknown }).lat !== "number") continue;
    const q = k.split("|")[0];
    const hit = v as { lat: number; lng: number; cc?: string; country?: string };
    // The plain lookup (no countries, no "near") wins: that's the one the page shows the stay at.
    if (!out.has(q) || k === `${q}|`) out.set(q, hit);
  }
  return out;
}

const staysOf = (trip: any): any[] => (Array.isArray(trip?.stays) ? trip.stays.filter((s: any) => s && typeof s.city === "string" && s.city.trim()) : []);
const pinOf = (s: any) => (typeof s.pin?.lat === "number" && typeof s.pin?.lng === "number" ? s.pin as { lat: number; lng: number } : null);
const nameOf = (s: any) => String(s.city).trim().toLowerCase();

/** Queues a lookup for the stays not looked up here (for their position and country); true while any is still to come. */
export function lookUpStays(trip: unknown, where: ReturnType<typeof placesByName>) {
  const missing = staysOf(trip).filter((s) => !where.has(nameOf(s)));
  return missing.length > 0 && geocodeBatch(missing.map((s) => ({ q: String(s.city), first: true }))).pending > 0;
}

export function tripCard(name: string, savedAt: string, trip: any, where: ReturnType<typeof placesByName>): TripCard {
  const stays = staysOf(trip);
  const dated = stays.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s.start || "")));
  const start = dated.map((s) => s.start).sort()[0] || "";
  const end = dated.map((s) => addDays(s.start, Number(s.nights) || 0)).sort().at(-1) || "";
  const located = stays.map((s) => ({ s, at: where.get(nameOf(s)) }));
  const route = located.map((x) => pinOf(x.s) || x.at).filter((at) => !!at).map((at) => [round(at.lat), round(at.lng)] as [number, number]);
  const countries = new Map<string, string>();
  for (const x of located) if (x.at?.cc) countries.set(x.at.cc, x.at.country || x.at.cc.toUpperCase());
  const days: any[] = Array.isArray(trip?.itinerary?.days) ? trip.itinerary.days : [];
  const stops = days.flatMap((d) => (Array.isArray(d?.items) ? d.items : []))
    .filter((x: any) => typeof x?.lat === "number" && typeof x?.lng === "number")
    .map((x: any) => [round(x.lat), round(x.lng)] as [number, number]);
  // At most ~120 dots, spread over the whole trip.
  const step = Math.max(1, Math.ceil(stops.length / 120));
  return {
    name, savedAt,
    title: String(trip?.itinerary?.destination || ""),
    cities: stays.map((s) => String(s.city).split(",")[0].trim()),
    start, end,
    nights: dated.reduce((n, s) => n + (Number(s.nights) || 0), 0),
    travelers: Number(trip?.travelers) || 1,
    days: days.length,
    cost: Number(trip?.itinerary?.totalEstimatedCost) || 0,
    currency: String(trip?.currency || ""),
    countries: [...countries.entries()].map(([cc, country]) => ({ cc, country })),
    route,
    dots: stops.filter((_, i) => i % step === 0),
    bookings: Array.isArray(trip?.bookings) ? trip.bookings.length : 0,
    mustSees: Object.values(trip?.marks || {}).filter((m) => m === "must").length,
  };
}

export function tripCards(): TripCard[] {
  if (!fs.existsSync(SAVES_DIR)) return [];
  const where = placesByName();
  return fs.readdirSync(SAVES_DIR).filter((f) => f.endsWith(".json")).flatMap((f) => {
    const file = path.join(SAVES_DIR, f);
    try {
      const trip = JSON.parse(fs.readFileSync(file, "utf8"));
      const card = tripCard(f.slice(0, -5), fs.statSync(file).mtime.toISOString(), trip, where);
      return [lookUpStays(trip, where) ? { ...card, locating: true } : card];
    } catch { return []; } // not readable: left out rather than breaking the list
  });
}
