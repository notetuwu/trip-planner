// Dates, money, distances and colours.

export const addDays = (iso: string, n: number | string) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
};
export const fmtDate = (iso: string) => iso ? new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
export const fmtShort = (iso: string) => iso ? new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "";
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

export const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
export const fmtDur = (s: number) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
};

const DAY_COLORS = ["#e4572e", "#2b8a3e", "#1c7ed6", "#ae3ec9", "#f59f00", "#0ca678", "#d6336c", "#4263eb", "#a9743b", "#1098ad"];
export const dayColor = (i: number) => DAY_COLORS[i % DAY_COLORS.length];

export const CURRENCIES = ["EUR", "USD", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "KRW", "CNY", "HKD", "TWD", "SGD", "THB", "VND", "IDR", "MYR", "PHP", "INR", "AED", "TRY", "MXN", "BRL", "ZAR"];
