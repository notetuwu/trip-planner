// Fuel prices for countries the EU's Weekly Oil Bulletin doesn't cover. Two have an official figure that's read live:
// Switzerland (the Federal Statistical Office's monthly average, shown on fuel-prices.eu), the United States (the
// Energy Information Administration's weekly average, public domain), Canada (Natural Resources Canada's weekly
// averages) and Australia (the Australian Institute of Petroleum's weekly petrol average). The rest come from a short
// table of rough typical prices, marked as estimates: enough for a budget, and the traveler can type the real price in.
import { USER_AGENT } from "../config";

/** `dieselApprox`: the petrol figure is official but the diesel one is a rough typical price. */
export interface ExtraPrice { petrol?: number; diesel?: number; week?: string; kind: "official" | "approx"; source: string; dieselApprox?: boolean }

/** How many of each currency one euro buys. */
type Rates = Record<string, number>;

/** Rough typical pump prices in euros a litre (petrol, diesel), around late 2025: not live figures. */
const APPROX_AS_OF = "2025";
const APPROX: Record<string, [number, number]> = {
  // Asia
  JP: [1.05, 0.95], KR: [1.1, 1.0], CN: [0.95, 0.88], TW: [0.88, 0.8], HK: [2.0, 1.9], SG: [2.0, 1.8], TH: [1.0, 0.85],
  VN: [0.8, 0.75], MY: [0.43, 0.45], ID: [0.7, 0.7], PH: [0.85, 0.8], KH: [1.0, 0.95], LA: [1.05, 1.0], IN: [1.0, 0.95],
  LK: [0.95, 0.9], NP: [1.2, 1.1], MN: [0.75, 0.8],
  // Middle East
  AE: [0.65, 0.7], SA: [0.55, 0.4], QA: [0.55, 0.55], OM: [0.65, 0.7], IL: [1.95, 1.95], JO: [1.1, 0.95],
  // Africa
  EG: [0.45, 0.4], MA: [1.15, 1.05], TN: [0.75, 0.7], ZA: [1.05, 1.0], KE: [1.3, 1.25], TZ: [1.15, 1.15],
  // Americas
  CA: [1.0, 1.05], MX: [1.15, 1.2], BR: [1.05, 1.0], AR: [1.0, 1.0], CL: [1.15, 0.95], PE: [1.15, 1.05], CO: [0.8, 0.8],
  CR: [1.25, 1.15], PA: [0.95, 0.95], EC: [0.6, 0.65], UY: [1.55, 1.35], US: [0.85, 0.95],
  // Oceania
  AU: [1.15, 1.15], NZ: [1.4, 1.2],
  // Europe outside the Bulletin, and the Caucasus and Central Asia
  IS: [2.0, 2.0], RS: [1.5, 1.5], AL: [1.7, 1.65], BA: [1.25, 1.2], ME: [1.5, 1.45], MK: [1.4, 1.3], XK: [1.45, 1.35],
  MD: [1.25, 1.25], UA: [1.15, 1.2], GE: [0.95, 0.95], AM: [0.95, 0.95], AZ: [0.5, 0.5], KZ: [0.45, 0.45],
  UZ: [0.55, 0.6], RU: [0.6, 0.65], BY: [0.6, 0.6], LI: [1.9, 2.1], AD: [1.5, 1.45], TR: [1.15, 1.15], CH: [2.2, 2.45],
};

const text = async (url: string) => {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&euro;/g, "€").replace(/&nbsp;|\s+/g, " ");
};
const sane = (n: number) => Number.isFinite(n) && n > 0.2 && n < 6;

/** Switzerland: "FSO · Oct 2026: petrol 2.12 CHF/L (€2.284/L), diesel 2.41 CHF/L (€2.596/L)" on fuel-prices.eu. */
export function parseSwiss(t: string): ExtraPrice | null {
  const m = t.match(/FSO[^A-Za-z0-9]{1,10}([A-Za-z]{3,9} \d{4}): petrol [\d.]+ CHF\/L \(€([\d.]+)\/L\), diesel [\d.]+ CHF\/L \(€([\d.]+)\/L\)/);
  if (!m || !sane(+m[2]) || !sane(+m[3])) return null;
  return { petrol: +m[2], diesel: +m[3], week: m[1], kind: "official", source: `Swiss Federal Statistical Office, ${m[1]} (via fuel-prices.eu)` };
}

/** The US: the national average a gallon in dollars, the latest week, from EIA's weekly update page. */
export function parseUs(t: string, usdPerEur: number): ExtraPrice | null {
  const row = (title: string) => {
    const m = t.match(new RegExp(`${title}[\\s\\S]{0,400}?Change from (\\d\\d)/(\\d\\d)/(\\d\\d) (\\d\\d)/(\\d\\d)/(\\d\\d) (\\d\\d)/(\\d\\d)/(\\d\\d)[\\s\\S]{0,300}?U\\.S\\. ([\\d.]+) ([\\d.]+) ([\\d.]+)`));
    return m ? { usd: +m[12], date: `20${m[9]}-${m[7]}-${m[8]}` } : null;
  };
  const p = row("U\\.S\\. Regular Gasoline Prices"), d = row("U\\.S\\. On-Highway Diesel Fuel Prices");
  if (!p || !d || !(usdPerEur > 0)) return null;
  const perLitre = (usd: number) => usd / 3.78541 / usdPerEur;
  const petrol = perLitre(p.usd), diesel = perLitre(d.usd);
  if (!sane(petrol) || !sane(diesel)) return null;
  return { petrol: Math.round(petrol * 1000) / 1000, diesel: Math.round(diesel * 1000) / 1000, week: p.date, kind: "official", source: `US Energy Information Administration, week of ${p.date}` };
}

/** Canada: the national weekly average in cents a litre (CAD) from the last row of Natural Resources Canada's table. */
export function parseNrcan(t: string, cadPerEur: number): { eur: number; date: string } | null {
  const rows = [...t.matchAll(/(\d{4}-\d\d-\d\d) ([\d.]+) /g)];
  const last = rows.at(-1);
  const eur = last && cadPerEur > 0 ? +last[2] / 100 / cadPerEur : NaN;
  return last && sane(eur) ? { eur: Math.round(eur * 1000) / 1000, date: last[1] } : null;
}

/** Australia: the national average petrol price in cents a litre (AUD) from the AIP's pump-price table. */
export function parseAip(t: string, audPerEur: number): { eur: number; week: string } | null {
  const m = t.match(/Week ending \w+, (\d+)\w* (\w+ \d{4})[\s\S]{0,200}?National Average ([\d.]+)/);
  const eur = m && audPerEur > 0 ? +m[3] / 100 / audPerEur : NaN;
  return m && sane(eur) ? { eur: Math.round(eur * 1000) / 1000, week: `${m[1]} ${m[2]}` } : null;
}

const NRCAN = (product: number) => `https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_bycity_e.cfm?productID=${product}&locationID=66,8,39,17&frequency=W`;

/** A price for a country outside the Bulletin: the official one where it's read live, else the rough table, else null. */
export async function extraFuel(cc: string, rates: Rates): Promise<ExtraPrice | null> {
  try {
    if (cc === "CH") { const p = parseSwiss(await text("https://www.fuel-prices.eu/Switzerland/")); if (p) return p; }
    if (cc === "US") { const p = parseUs(await text("https://www.eia.gov/petroleum/gasdiesel/"), rates.USD); if (p) return p; }
    if (cc === "CA") {
      const [p, d] = await Promise.all([text(NRCAN(1)), text(NRCAN(5))]);
      const petrol = parseNrcan(p, rates.CAD), diesel = parseNrcan(d, rates.CAD);
      if (petrol && diesel) return { petrol: petrol.eur, diesel: diesel.eur, week: petrol.date, kind: "official", source: `Natural Resources Canada, week ending ${petrol.date}` };
    }
    if (cc === "AU") {
      // The page loads its table with this request; only the petrol average is published that way.
      const res = await fetch("https://aip.com.au/wp-admin/admin-ajax.php", { method: "POST", headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "load_fuel_table", post_id: "1196", current_url: "https://aip.com.au/pricing/pump-prices/" }), signal: AbortSignal.timeout(15_000) });
      const p = parseAip((await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), rates.AUD);
      if (p && APPROX.AU) return { petrol: p.eur, diesel: APPROX.AU[1], week: p.week, kind: "official", dieselApprox: true, source: `Australian Institute of Petroleum, week ending ${p.week} (petrol; diesel is a rough typical price)` };
    }
  } catch { /* the rough table below */ }
  const a = APPROX[cc];
  return a ? { petrol: a[0], diesel: a[1], kind: "approx", source: `rough typical price, ${APPROX_AS_OF}` } : null;
}
