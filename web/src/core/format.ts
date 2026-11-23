// Dates, times, money, distances and colours (in the units and formats chosen in Settings → General).
import { prefs } from "./prefs";

export const addDays = (iso: string, n: number | string) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
};
/** The locale dates are written in: the system's, or day first ("Mon, 2 Nov") or month first ("Mon, Nov 2"). */
const dateLocale = () => (prefs.app.dates === "dmy" ? "en-GB" : prefs.app.dates === "mdy" ? "en-US" : undefined);
export const fmtDate = (iso: string) => iso ? new Date(iso + "T00:00:00Z").toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
export const fmtShort = (iso: string) => iso ? new Date(iso + "T00:00:00Z").toLocaleDateString(dateLocale(), { month: "short", day: "numeric", timeZone: "UTC" }) : "";
/** A stop's "14:30" as set: unchanged, or "2:30 pm". Anything that isn't a time stays as it is. */
export const fmtTime = (t: string) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})(.*)$/);
  if (!m || prefs.app.clock !== "12") return t;
  const h = Number(m[1]) % 24;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "am" : "pm"}${m[3]}`;
};
export const todayIso = () => new Date().toLocaleDateString("sv");
export const daysBetween = (a: string, b: string) => Math.round((+new Date(b + "T00:00:00Z") - +new Date(a + "T00:00:00Z")) / 864e5);

/** "5 min ago", "3 h ago"… */
export const ago = (iso: string | undefined) => {
  const m = Math.round((Date.now() - +new Date(iso || 0)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export function money(n: number | undefined, cur: string) {
  if (n == null || isNaN(n)) return "";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: ["JPY", "KRW", "VND", "IDR", "HUF"].includes(cur) ? 0 : 2 }).format(n); }
  catch { return `${Math.round(n)} ${cur}`; }
}

export const fmtDist = (m: number) => {
  if (prefs.app.units === "mi") {
    const mi = m / 1609.344;
    return mi < 0.1 ? `${Math.round((m * 3.28084) / 10) * 10} ft` : `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
  }
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
};
/** Whole kilometres (detours, drives) in the chosen unit: "245 km" or "152 mi". */
export const fmtKm = (km: number) => (prefs.app.units === "mi" ? `${Math.round(km / 1.609344).toLocaleString()} mi` : `${Math.round(km).toLocaleString()} km`);
/** A temperature (°C from the forecast) in the chosen unit, without the unit sign's letter: "18°". */
export const fmtTemp = (c: number) => `${Math.round(prefs.app.units === "mi" ? c * 1.8 + 32 : c)}°`;
export const fmtDur = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
};

const DAY_COLORS = ["#e4572e", "#2b8a3e", "#1c7ed6", "#ae3ec9", "#f59f00", "#0ca678", "#d6336c", "#4263eb", "#a9743b", "#1098ad"];
export const dayColor = (i: number) => DAY_COLORS[i % DAY_COLORS.length];

export const CURRENCIES = ["EUR", "USD", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "KRW", "CNY", "HKD", "TWD", "SGD", "THB", "VND", "IDR", "MYR", "PHP", "INR", "AED", "TRY", "MXN", "BRL", "ZAR"];
