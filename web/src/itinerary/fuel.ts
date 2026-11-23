// The fuel estimate in the cost breakdown: how far they drive (the routed drives between stays reached by car, the
// driving legs on days spent at those stays, and from the stay to the day's first stop and back) times their car's
// consumption, at each country's fuel price (the weekly national averages from the server, or their own price), in
// the trip's currency. Not added to the plan's total: the plan's own transfer costs may include fuel already.
import { api, esc } from "../core/dom";
import { fmtDate, fmtKm, money } from "../core/format";
import { save, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { distKm, stayLoc, stayOn } from "../geo/locate";
import { stayLegs } from "../map/draw-stays";
import { dayLegs, legRoute, routeKey, routes } from "../map/routes";
import { arrivalStay, isTransfer } from "../map/travel-day";
import { plannedMode } from "../trip/modes";
import type { LatLng } from "../../../shared/types";

type Fuel = "petrol" | "diesel" | "electric";
interface FuelPrice { petrol?: number; diesel?: number; week?: string }

/** EU weighted averages, week of 16 Nov 2026 (EU Weekly Oil Bulletin): for countries without a weekly figure. */
const EU_AVERAGE = { petrol: 1.829, diesel: 2.05 };
const DEFAULT_PER100: Record<Fuel, number> = { petrol: 7, diesel: 6, electric: 18 };
const DEFAULT_KWH = 0.45;
/** Roads wind: a straight line times this, where the road route isn't known (yet). */
const WIND = 1.25;

let prices: Record<string, FuelPrice | null> = {}, rates: Record<string, number> = { EUR: 1 }, attribution = { text: "", url: "" };
let asked = "";

const ll = (p: LatLng) => ({ lat: p[0], lng: p[1] });
const roadKm = (a: LatLng, b: LatLng) => { const r = routes[routeKey("car", a, b)]; return r ? r.d / 1000 : distKm(ll(a), ll(b)) * WIND; };
const ccOf = (i: number) => (stayLoc(state.stays[i])?.cc || "").toUpperCase();

/** Whether they reach stay i by car (chosen, or what the plan picked when left to it). */
function byCar(i: number): boolean {
  const s = state.stays[i];
  if (!s) return false;
  if (i === 0) return byCar(1) || !state.stays[1]; // the first stay: by car when they drive on from it
  return (s.travel || plannedMode(state.stays[i - 1].city, s.city)) === "car";
}

interface DayDrive { di: number; km: number; ccs: string[] }

/** Kilometres driven each day by car, and the countries they're in. */
export function drives(): DayDrive[] {
  const it = state.itinerary;
  if (!it) return [];
  const byTitle = byTitleMap(), legs = stayLegs();
  return it.days.map((d, di) => {
    let km = 0;
    const arrive = arrivalStay(d), stay = stayOn(d), si = stay ? state.stays.indexOf(stay) : -1;
    const ccs = new Set<string>();
    // The drive between the stays, through the stops on the way.
    const drive = arrive > 0 && byCar(arrive) ? legs.find((l) => !l.trip && l.i === arrive) : undefined;
    if (drive) {
      const pts = [drive.from, ...(drive.via || []).map((v) => v.loc), drive.to];
      for (let k = 1; k < pts.length; k++) km += roadKm(pts[k - 1], pts[k]);
      ccs.add(ccOf(arrive - 1)); ccs.add(ccOf(arrive));
    }
    // A day at a stay reached by car: its driving legs, and to the first stop and back from the last.
    const carDay = arrive > 0 ? byCar(arrive) : si >= 0 && byCar(si);
    if (carDay) {
      const car = dayLegs(d, byTitle).filter((l) => l.mode === "car");
      for (const l of car) { const r = legRoute(l); km += r ? r.d / 1000 : distKm(ll(l.from), ll(l.to)) * WIND; }
      const home = si >= 0 ? stayLoc(state.stays[si]) : null;
      const stops = d.items.filter((x) => !isTransfer(x)).map((x) => itemLoc(x, d, byTitle)).filter((l): l is NonNullable<typeof l> => !!l && !l.elsewhere);
      if (home && stops.length && !drive && (car.length || d.items.some((x) => isTransfer(x) && /\bcar|drive\b/i.test(`${x.place} ${x.transport || ""}`)))) {
        for (const end of [stops[0], stops.at(-1)!]) { const k = distKm(home, end); if (k > 1.5) km += k * WIND; }
      }
      if (si >= 0) ccs.add(ccOf(si));
    }
    return { di, km: Math.round(km), ccs: [...ccs].filter(Boolean) };
  });
}

/** The price a litre (EUR) in a country: theirs, the weekly average, else the EU average (then `assumed`). */
function priceIn(cc: string, fuel: "petrol" | "diesel") {
  const own = state.car?.prices?.[cc];
  if (own) return { eur: own, own: true, assumed: false };
  const p = prices[cc]?.[fuel];
  return p ? { eur: p, own: false, assumed: false } : { eur: EU_AVERAGE[fuel], own: false, assumed: true };
}

/** The estimate: per day and per country, in EUR and in the trip's currency. */
export function fuelEstimate() {
  const car = state.car;
  if (!car?.fuel) return null;
  const per100 = car.per100 || DEFAULT_PER100[car.fuel];
  const days = drives().filter((d) => d.km > 0);
  const unitEur = (cc: string) => (car.fuel === "electric" ? car.kwhPrice || DEFAULT_KWH : priceIn(cc, car.fuel as "petrol" | "diesel").eur);
  const countries = new Map<string, number>();
  const perDay = days.map((d) => {
    const share = d.km / Math.max(1, d.ccs.length);
    for (const cc of d.ccs.length ? d.ccs : [""]) countries.set(cc, (countries.get(cc) || 0) + share);
    const eur = (d.ccs.length ? d.ccs : [""]).reduce((n, cc) => n + (share * per100 / 100) * unitEur(cc), 0);
    return { ...d, eur };
  });
  const km = days.reduce((n, d) => n + d.km, 0);
  const amount = km * per100 / 100;
  const eur = perDay.reduce((n, d) => n + d.eur, 0);
  const rate = rates[state.currency] || (state.currency === "EUR" ? 1 : 0);
  return { per100, km, amount, eur, rate, perDay, countries: [...countries].map(([cc, k]) => ({ cc, km: Math.round(k), ...(car.fuel === "electric" ? { eur: car.kwhPrice || DEFAULT_KWH, own: !!car.kwhPrice, assumed: !car.kwhPrice } : priceIn(cc, car.fuel as "petrol" | "diesel")) })) };
}

/** Asks the server for the trip's countries' prices and the exchange rates (once per set of countries). */
export async function loadFuelData(): Promise<boolean> {
  const ccs = [...new Set(state.stays.map((s) => (stayLoc(s)?.cc || "").toUpperCase()).filter(Boolean))].sort().join(",");
  if (!ccs || ccs === asked) return false;
  asked = ccs;
  try {
    const [f, fx] = await Promise.all([api<{ prices: typeof prices; attribution: typeof attribution }>(`/api/fuel?cc=${ccs}`), api<Record<string, number>>("/api/fx")]);
    prices = f.prices; attribution = f.attribution; rates = fx;
    return true;
  } catch { asked = ""; return false; }
}

const countryName = (cc: string) => { try { return cc ? new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || cc : "Unknown country"; } catch { return cc; } };

/** The fuel section of the cost breakdown. */
export function fuelHtml() {
  const car = state.car || { fuel: "" as const, per100: 0 };
  const cur = state.currency;
  const opt = (v: string, label: string) => `<option value="${v}"${car.fuel === v ? " selected" : ""}>${label}</option>`;
  const unit = car.fuel === "electric" ? "kWh" : "l";
  const head = `<h3>Fuel <span class="hint">estimate</span></h3>
    <div class="fuel-car">
      <label>Your car<select data-fuel="fuel">${opt("", "No car / don't estimate")}${opt("petrol", "Petrol")}${opt("diesel", "Diesel")}${opt("electric", "Electric")}</select></label>
      ${car.fuel ? `<label>Uses (${unit} / 100 km)<input type="number" min="1" max="60" step="0.1" data-fuel="per100" value="${car.per100 || ""}" placeholder="${DEFAULT_PER100[car.fuel]}"></label>` : ""}
      ${car.fuel === "electric" ? `<label>Charging (EUR / kWh)<input type="number" min="0" max="3" step="0.01" data-fuel="kwhPrice" value="${car.kwhPrice || ""}" placeholder="${DEFAULT_KWH}"></label>` : ""}
    </div>`;
  const est = fuelEstimate();
  if (!est) return `${head}<p class="hint">Pick your car's fuel to estimate what the drives cost, at each country's fuel prices.</p>`;
  const inCur = (eur: number) => (est.rate ? money(eur * est.rate, cur) : money(eur, "EUR"));
  const weeks = [...new Set(Object.values(prices).map((p) => p?.week).filter(Boolean))].sort();
  return `${head}
    <div class="stats cb-stats">
      <div class="stat"><b>${inCur(est.eur)}</b><span>fuel for the trip${est.rate && cur !== "EUR" ? ` (${money(est.eur, "EUR")})` : ""}</span></div>
      <div class="stat"><b>${esc(fmtKm(est.km))}</b><span>driven by car</span></div>
      <div class="stat"><b>${Math.round(est.amount).toLocaleString()} ${unit}</b><span>at ${est.per100} ${unit} / 100 km</span></div>
    </div>
    <table class="cb-table fuel-table">${est.countries.map((c) => `<tr><td>${esc(countryName(c.cc))}</td><td class="num muted">${esc(fmtKm(c.km))}</td>
      <td class="num">${car.fuel === "electric" ? `${money(c.eur, "EUR")} / kWh` : `<input type="number" min="0" max="5" step="0.001" data-fuel-cc="${esc(c.cc)}" value="${c.own ? c.eur : ""}" placeholder="${c.eur.toFixed(3)}" title="${c.assumed ? "No weekly figure for this country: the EU average, until you enter its price" : "The weekly national average: enter your own to change it"}"> € / l${c.assumed ? ` <span class="muted" title="EU average">*</span>` : ""}`}</td>
      <td class="num">${inCur(c.km * est.per100 / 100 * c.eur)}</td></tr>`).join("")}</table>
    <details class="cb-day"><summary><span class="cb-date">Per day</span><span class="cb-city"></span><span class="num">${est.perDay.length} days with driving</span></summary>
      <table class="cb-table">${est.perDay.map((d) => `<tr><td class="muted">${esc(fmtDate(state.itinerary!.days[d.di].date))}</td><td>${esc(state.itinerary!.days[d.di].city)}</td><td class="num muted">${esc(fmtKm(d.km))}</td><td class="num">${inCur(d.eur)}</td></tr>`).join("")}</table></details>
    <p class="hint">Distances: the drives between stays you reach by car (along the road where it's routed), the driving on days there, and to the first stop and back. ${car.fuel === "electric" ? "Charging at the price you set (free chargers make it less)." : `Prices: weekly national averages${weeks.length ? ` (week of ${esc(fmtDate(weeks.at(-1)!))})` : ""}; * the EU average where there's no figure (enter the price there).`} Not added to the total above: the plan's transfer costs may already include fuel.${attribution.text && car.fuel !== "electric" ? ` <a href="${esc(attribution.url)}" target="_blank" rel="noopener">${esc(attribution.text)}</a>` : ""}${!est.rate && cur !== "EUR" ? ` No exchange rate for ${esc(cur)} right now, so in euros.` : ""}</p>`;
}

/** Changes in the fuel section: saved with the trip, then `redraw` shows the new estimate. */
export function wireFuel(root: HTMLElement, redraw: () => void) {
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-fuel], [data-fuel-cc]").forEach((el) => {
    el.onchange = () => {
      const car = { fuel: "" as Fuel | "", per100: 0, ...(state.car || {}) };
      const k = el.dataset.fuel, cc = el.dataset.fuelCc, v = Number(el.value);
      if (k === "fuel") { car.fuel = el.value as Fuel | ""; car.per100 = 0; }
      else if (k === "per100") car.per100 = v > 0 ? v : 0;
      else if (k === "kwhPrice") car.kwhPrice = v > 0 ? v : undefined;
      else if (cc != null) { car.prices = { ...(car.prices || {}) }; if (v > 0) car.prices[cc] = v; else delete car.prices[cc]; }
      state.car = car;
      save(); redraw();
    };
  });
}
