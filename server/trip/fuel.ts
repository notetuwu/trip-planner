// Fuel prices and exchange rates for the fuel estimate in the cost breakdown.
// Fuel: the latest weekly national average per country from fuel-prices.eu (the European Commission's Weekly Oil
// Bulletin, CC BY 4.0: the page shows the credit next to the figures). It covers the EU, the UK and Norway; for
// Switzerland and the US an official figure is read live, and for other countries there's a table of rough typical
// prices (see fuel-extra.ts), marked as approximate. Exchange rates: the ECB's daily reference rates via
// frankfurter.dev. Both cached for a day.
import { USER_AGENT, errMsg } from "../config";
import { diskCache } from "../util/disk-cache";
import { extraFuel } from "./fuel-extra";

/** `kind`: the weekly bulletin (no kind), an official figure read live, or a rough typical price; `source` says where. */
export interface FuelPrice { petrol?: number; diesel?: number; week?: string; kind?: "official" | "approx"; source?: string }
const DAY = 24 * 3600e3;
const fuelCache = diskCache<{ at: number; price: FuelPrice | null }>("fuel.json");
const fxCache = diskCache<{ at: number; rates: Record<string, number> }>("fx.json");

/** The last week with a figure in a weekly series. */
const latest = (labels: string[], values: (number | null)[]) => {
  for (let i = values.length - 1; i >= 0; i--) if (typeof values[i] === "number" && values[i]! > 0) return { v: values[i]!, week: labels[i] };
  return null;
};

async function fuelFor(cc: string): Promise<FuelPrice | null> {
  const hit = fuelCache.data[cc];
  if (hit && Date.now() - hit.at < DAY) return hit.price;
  try {
    const res = await fetch(`https://www.fuel-prices.eu/lang/api/country-history.php?cc=${encodeURIComponent(cc)}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(12_000) });
    const j: any = await res.json();
    if (j?.error || !Array.isArray(j?.labels)) { fuelCache.data[cc] = { at: Date.now(), price: null }; fuelCache.save(); return null; }
    const p = latest(j.labels, j.e95 || []), d = latest(j.labels, j.diesel || []);
    const price: FuelPrice = { ...(p ? { petrol: p.v } : {}), ...(d ? { diesel: d.v } : {}), week: (p || d)?.week };
    fuelCache.data[cc] = { at: Date.now(), price }; fuelCache.save();
    return price;
  } catch (e) {
    console.error(`Fuel prices for ${cc}:`, errMsg(e));
    return hit?.price ?? null; // an older answer beats none
  }
}

/** Outside the bulletin: the live official figure (cached a day) or the rough table. */
async function extraFor(cc: string): Promise<FuelPrice | null> {
  const key = `x:${cc}`, hit = fuelCache.data[key];
  if (hit && Date.now() - hit.at < DAY) return hit.price;
  const price = await extraFuel(cc, (await eurRates()).USD);
  if (price?.kind === "official") { fuelCache.data[key] = { at: Date.now(), price }; fuelCache.save(); }
  return price;
}

/** Prices per country code (upper case), null where there's no figure. */
export async function fuelPrices(ccs: string[]) {
  const list = [...new Set(ccs.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))].slice(0, 20);
  const out: Record<string, FuelPrice | null> = {};
  for (const cc of list) out[cc] = (await fuelFor(cc === "GR" ? "EL" : cc)) ?? (await extraFor(cc));
  return { prices: out, attribution: { text: "Data: fuel-prices.eu, CC BY 4.0", url: "https://www.fuel-prices.eu/" } };
}

/** How many of each currency one euro buys (EUR itself is 1). */
export async function eurRates() {
  const hit = fxCache.data.EUR;
  if (hit && Date.now() - hit.at < DAY) return hit.rates;
  try {
    const j: any = await (await fetch("https://api.frankfurter.dev/v1/latest?base=EUR", { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(12_000) })).json();
    const rates = { EUR: 1, ...(j?.rates || {}) };
    fxCache.data.EUR = { at: Date.now(), rates }; fxCache.save();
    return rates;
  } catch (e) {
    console.error("Exchange rates:", errMsg(e));
    return hit?.rates || { EUR: 1 };
  }
}
