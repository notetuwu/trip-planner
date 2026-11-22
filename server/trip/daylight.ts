// Sunrise and sunset at each stay, so the planner puts shrines, gardens and viewpoints in daylight (in November in
// Japan the sun sets before 17:00). Worked out from the sun's position (NOAA's formula, about a minute off); the
// local time zone comes from Open-Meteo (cached), else roughly from the longitude.
import type { TripStay } from "../../shared/types";
import { USER_AGENT, addDays } from "../config";
import { diskCache } from "../util/disk-cache";

const zones = diskCache<string>("time-zones.json");
const rad = Math.PI / 180;

/** Sunrise and sunset in minutes after midnight UTC on that date, or null in polar day / night. */
export function sunUtc(lat: number, lng: number, iso: string): { rise: number; set: number } | null {
  const d = new Date(`${iso}T12:00:00Z`);
  const n = Math.round((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  const g = (2 * Math.PI / 365) * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const x = Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl);
  if (Math.abs(x) > 1) return null;
  const ha = Math.acos(x) / rad;
  return { rise: 720 - 4 * (lng + ha) - eq, set: 720 - 4 * (lng - ha) - eq };
}

/** The IANA time zone at a point ("Asia/Tokyo"); a fixed offset from the longitude if Open-Meteo can't be reached. */
async function zoneAt(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
  if (zones.data[key]) return zones.data[key];
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&timezone=auto&forecast_days=1&daily=sunset`,
      { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
    const tz = res.ok ? String(((await res.json()) as any).timezone || "") : "";
    if (tz && tz !== "GMT") { zones.data[key] = tz; zones.save(); return tz; }
  } catch { /* offline: guess below */ }
  const off = Math.round(lng / 15);
  return off === 0 ? "UTC" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`; // Etc/ zones have the sign flipped
}

/** "06:24" in that zone, for minutes after midnight UTC on the date. */
export function localTime(iso: string, minutesUtc: number, zone: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, Math.round(minutesUtc))).toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit" });
}

/** "sunrise 06:22, sunset 17:03" for one day there. */
function dayLight(lat: number, lng: number, iso: string, zone: string) {
  const s = sunUtc(lat, lng, iso);
  return s ? `sunrise ${localTime(iso, s.rise, zone)}, sunset ${localTime(iso, s.set, zone)}` : "";
}

/** Per stay (by index): daylight on its first and last day, e.g. "sunrise 06:22, sunset 17:03 on arrival; … on departure". */
export async function stayDaylight(stays: TripStay[]): Promise<string[]> {
  return Promise.all(stays.map(async (s) => {
    if (typeof s.lat !== "number" || typeof s.lng !== "number" || !s.start) return "";
    const zone = await zoneAt(s.lat, s.lng);
    const first = dayLight(s.lat, s.lng, s.start, zone);
    const nights = Number(s.nights) || 0;
    const last = nights > 2 ? dayLight(s.lat, s.lng, addDays(s.start, nights), zone) : "";
    return !first ? "" : last && last !== first ? `${first} at the start, ${last} at the end` : first;
  }));
}
