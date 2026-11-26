// The weather on each day of the plan, from Open-Meteo: the forecast for days in the next ~2 weeks, the weather it was on
// days gone by, and further ahead what's typical for the date (the average of the same days in the last five years).
// The past and the typical don't change, so they're kept in this browser.
import { addDays, todayIso } from "../core/format";
import { session, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { type Loc, stayLoc } from "../geo/locate";
import { renderItinerary } from "./render";
import { type IconName, icon } from "../core/icons";

export type Weather = { code: number; max: number; min: number; kind?: "forecast" | "was" | "typical" };

const WMO: [number, IconName][] = [[0, "sun"], [2, "cloudSun"], [3, "cloud"], [48, "cloudFog"], [57, "cloudDrizzle"], [67, "cloudRain"], [77, "cloudSnow"], [82, "cloudRain"], [86, "cloudSnow"], [99, "cloudLightning"]];
const bucket = (code: number) => WMO.findIndex(([max]) => code <= max);
export const wmoIcon = (code: number) => icon((WMO.find(([max]) => code <= max) || WMO.at(-1)!)[1]);

/** What the weather shown is, for its tooltip. */
export const weatherTitle = (w: Weather) => w.kind === "was" ? "The weather that day" : w.kind === "typical" ? "Typical for the date: the average of the same days in the last 5 years" : "Forecast";

const YEARS = 5, FORECAST_DAYS = 15, RECENT_DAYS = 60;
const CACHE = "trip-planner-weather-v1";
let cache: Record<string, Weather> | null = null;
const cached = () => (cache ??= (() => { try { return JSON.parse(localStorage.getItem(CACHE) || "{}"); } catch { return {}; } })());
function keep(key: string, w: Weather) {
  const c = cached();
  c[key] = w;
  const keys = Object.keys(c);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete c[k];
  try { localStorage.setItem(CACHE, JSON.stringify(c)); } catch { /* full */ }
}

/** The same day in an earlier year (29 February as the 28th). */
const yearsBack = (date: string, n: number) => `${Number(date.slice(0, 4)) - n}${date.slice(4) === "-02-29" ? "-02-28" : date.slice(4)}`;

type Daily = { time: string[]; weather_code: (number | null)[]; temperature_2m_max: (number | null)[]; temperature_2m_min: (number | null)[] };
async function daily(api: "forecast" | "archive", loc: Loc, from: string, to: string): Promise<Daily | null> {
  const host = api === "archive" ? "archive-api.open-meteo.com/v1/archive" : "api.open-meteo.com/v1/forecast";
  try {
    const res = await fetch(`https://${host}?latitude=${loc.lat}&longitude=${loc.lng}&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${from}&end_date=${to}`);
    return res.ok ? (await res.json()).daily : null;
  } catch { return null; }
}
const at = (d: Daily, i: number): Weather | null =>
  d.weather_code[i] == null || d.temperature_2m_max[i] == null || d.temperature_2m_min[i] == null ? null : { code: d.weather_code[i]!, max: d.temperature_2m_max[i]!, min: d.temperature_2m_min[i]! };

/** The forecast, or the weather it was (recent days from the forecast service, older ones from its archive). */
async function actual(loc: Loc, dates: string[], kind: "forecast" | "was", api: "forecast" | "archive", key: (d: string) => string) {
  const d = await daily(api, loc, dates[0], dates.at(-1)!);
  if (!d) return;
  d.time.forEach((date, i) => {
    const w = at(d, i);
    if (!w || !dates.includes(date)) return;
    session.weather[date] = { ...w, kind };
    if (kind === "was") keep(key(date), session.weather[date]);
  });
}

/** What's typical: the same days in each of the last five years, averaged (the most common sky). */
async function typical(loc: Loc, dates: string[], key: (d: string) => string) {
  const years = await Promise.all(Array.from({ length: YEARS }, (_, k) => {
    // Years back from now, not from the trip (a trip two years ahead still uses the last five years there are).
    const n = Number(dates[0].slice(0, 4)) - Number(todayIso().slice(0, 4)) + k + 1;
    return daily("archive", loc, yearsBack(dates[0], n), yearsBack(dates.at(-1)!, n)).then((d) => ({ n, d }));
  }));
  for (const date of dates) {
    const seen: Weather[] = [];
    for (const { n, d } of years) { const i = d?.time.indexOf(yearsBack(date, n)) ?? -1; const w = i >= 0 ? at(d!, i) : null; if (w) seen.push(w); }
    if (!seen.length) continue;
    const count = new Map<number, number>();
    for (const w of seen) count.set(bucket(w.code), (count.get(bucket(w.code)) || 0) + 1);
    const sky = [...count].sort((a, b) => b[1] - a[1])[0][0];
    const avg = (f: (w: Weather) => number) => Math.round(seen.reduce((s, w) => s + f(w), 0) / seen.length * 10) / 10;
    session.weather[date] = { code: seen.find((w) => bucket(w.code) === sky)!.code, max: avg((w) => w.max), min: avg((w) => w.min), kind: "typical" };
    keep(key(date), session.weather[date]);
  }
}

export async function loadWeather() {
  const it = state.itinerary; if (!it) return;
  const t = todayIso(), horizon = addDays(t, FORECAST_DAYS), recent = addDays(t, -RECENT_DAYS), byTitle = byTitleMap();
  const kindOf = (date: string) => (date > horizon ? "typical" : date >= t ? "forecast" : "was");
  const todo = new Map<string, { loc: Loc; key: string; dates: string[] }>();
  let changed = false;
  for (const d of it.days) {
    if (session.weather[d.date] || !d.date) continue;
    const stay = state.stays.find((s) => s.city === d.city);
    const loc = (stay && stayLoc(stay)) || d.items.map((x) => itemLoc(x, d, byTitle)).find(Boolean);
    if (!loc) continue;
    const place = `${loc.lat.toFixed(2)},${loc.lng.toFixed(2)}`, kind = kindOf(d.date);
    const hit = kind === "forecast" ? null : cached()[`${kind}|${place}|${d.date}`];
    if (hit) { session.weather[d.date] = hit; changed = true; continue; }
    // Recent days come from the forecast service (the archive is a few days behind).
    const how = kind === "was" && d.date < recent ? "archive" : kind;
    const k = `${how}|${place}`;
    if (!todo.has(k)) todo.set(k, { loc, key: place, dates: [] });
    todo.get(k)!.dates.push(d.date);
  }
  await Promise.all([...todo].map(([k, { loc, key, dates }]) => {
    const how = k.split("|")[0], keyOf = (kind: string) => (date: string) => `${kind}|${key}|${date}`;
    if (how === "typical") return typical(loc, dates, keyOf("typical"));
    if (how === "forecast") return actual(loc, dates, "forecast", "forecast", keyOf("forecast"));
    return actual(loc, dates, "was", how === "archive" ? "archive" : "forecast", keyOf("was"));
  }));
  if (todo.size || changed) renderItinerary();
}
