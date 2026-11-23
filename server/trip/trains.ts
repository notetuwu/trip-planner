// Real train connections for the planner, from Transitous (a public transport router with real timetables): between
// stays travelled by train (or left to the planner), from a stop on the way on to the next stay, and out to day trips.
// Models get Japan's or Europe's rail network wrong from memory (Kyoto → Tokyo → back to Odawara instead of the direct
// Shinkansen to Odawara), so they get the actual connection with station names, lines and the time it takes.
import type { Place } from "../../shared/types";
import type { Trip } from "../ai/types";
import { USER_AGENT } from "../config";
import { locateTown } from "../geo/geocode";

type Pt = { lat: number; lng: number };
const MODES = "RAIL,SUBURBAN,HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,REGIONAL_FAST_RAIL,METRO,SUBWAY,TRAM,FUNICULAR,BUS,COACH,FERRY";
const KIND: Record<string, string> = { HIGHSPEED_RAIL: "high-speed train", LONG_DISTANCE: "long-distance train", NIGHT_RAIL: "night train", REGIONAL_FAST_RAIL: "regional express", REGIONAL_RAIL: "regional train", SUBURBAN: "suburban train", RAIL: "train", METRO: "metro", SUBWAY: "subway", TRAM: "tram", BUS: "bus", COACH: "coach", FERRY: "ferry", FUNICULAR: "funicular" };
const cache = new Map<string, string | null>();

/** The fastest connection as one line: "Shin-Osaka → Odawara (ひかり 639号, high-speed train); Odawara → 箱根湯本 (…); about 2 h 15 min". */
async function connection(a: Pt, b: Pt): Promise<string | null> {
  const key = `${a.lat.toFixed(3)},${a.lng.toFixed(3)}>${b.lat.toFixed(3)},${b.lng.toFixed(3)}`;
  if (cache.has(key)) return cache.get(key)!;
  let line: string | null = null;
  try {
    // A sight's or town's point can be a long walk from its station (Nara Park): allow 30 minutes, then an hour.
    let its: any[] = [];
    for (const walk of ["1800", "3600"]) {
      const q = new URLSearchParams({ fromPlace: `${a.lat},${a.lng}`, toPlace: `${b.lat},${b.lng}`, maxPreTransitTime: walk, maxPostTransitTime: walk, transitModes: MODES });
      const res = await fetch(`https://api.transitous.org/api/v5/plan?${q}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
      its = res.ok ? (((await res.json()) as any).itineraries || []).filter((it: any) => it.legs?.some((l: any) => l.mode !== "WALK")) : [];
      if (its.length) break;
    }
    if (its.length) {
      const it = its.reduce((x: any, y: any) => (y.duration < x.duration ? y : x));
      // Line names, but not the bare internal numbers some timetables have instead ("17222914").
      const name = (l: any) => [l.routeShortName, l.headsign].find((n) => n && !/^\d{5,}$/.test(String(n)));
      const parts = it.legs.filter((l: any) => l.mode !== "WALK").map((l: any) => `${l.from?.name || "?"} → ${l.to?.name || "?"} (${[name(l), KIND[l.mode] || l.mode.toLowerCase()].filter(Boolean).join(", ")})`);
      const min = Math.round(it.duration / 60);
      line = `${parts.join("; ")}; about ${min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`} door to door`;
    }
  } catch { /* no connection info: the model plans it itself */ }
  cache.set(key, line);
  return line;
}

const has = (p: { lat?: number; lng?: number } | undefined): p is Pt => typeof p?.lat === "number" && typeof p?.lng === "number";

/** The connections worth knowing for this trip, as prompt lines ("- Osaka → Hakone: …"). */
export async function trainConnections(trip: Trip, places: Place[], onStatus: (s: string) => void): Promise<string[]> {
  const asks: { label: string; a: Pt; b: Pt }[] = [];
  const rail = (m?: string) => !m || m === "train";
  trip.stays.forEach((s, i) => {
    const prev = trip.stays[i - 1];
    if (i > 0 && rail(s.travel) && has(prev) && has(s) && prev.city !== s.city) {
      asks.push({ label: `${prev.city} → ${s.city}`, a: prev, b: s });
      // Stops on the way (a must-see on that travel day): from there on to the stay.
      for (const p of places) {
        const r = trip.mustSeeRoute?.[p.title];
        if (has(p) && (r?.how === "way" || r?.onWay) && r.leg?.to === s.city) asks.push({ label: `${p.title} (on the way) → ${s.city}`, a: p, b: s });
      }
    }
  });
  for (const s of trip.stays) {
    for (const t of s.dayTrips || []) {
      if (!t.place || !rail(t.mode) || !has(s)) continue;
      const hit = await locateTown(t.place, s.cc).catch(() => null);
      if (hit) asks.push({ label: `${s.city} → ${t.place} (day trip)`, a: s, b: hit });
    }
  }
  if (!asks.length) return [];
  onStatus("Looking up train connections…");
  const out: string[] = [];
  for (const q of asks.slice(0, 12)) {
    const line = await connection(q.a, q.b);
    if (line) out.push(`- ${q.label}: ${line}`);
  }
  return out;
}
