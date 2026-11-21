// Forecasts from Open-Meteo, only for itinerary days in the next ~2 weeks.
import { addDays, todayIso } from "../core/format";
import { session, state } from "../core/state";
import { byTitleMap, itemLoc } from "../geo/item-loc";
import { type Loc, stayLoc } from "../geo/locate";
import { renderItinerary } from "./render";
import { type IconName, icon } from "../core/icons";

const WMO: [number, IconName][] = [[0, "sun"], [2, "cloudSun"], [3, "cloud"], [48, "cloudFog"], [57, "cloudDrizzle"], [67, "cloudRain"], [77, "cloudSnow"], [82, "cloudRain"], [86, "cloudSnow"], [99, "cloudLightning"]];
export const wmoIcon = (code: number) => icon((WMO.find(([max]) => code <= max) || WMO.at(-1)!)[1]);

export async function loadWeather() {
  const it = state.itinerary; if (!it) return;
  const t = todayIso(), horizon = addDays(t, 15), byTitle = byTitleMap();
  const days = it.days.filter((d) => d.date >= t && d.date <= horizon && !session.weather[d.date]);
  const byPlace = new Map<string, { loc: Loc; dates: string[] }>();
  for (const d of days) {
    const stay = state.stays.find((s) => s.city === d.city);
    const loc = (stay && stayLoc(stay)) || d.items.map((x) => itemLoc(x, d, byTitle)).find(Boolean);
    if (!loc) continue;
    const key = `${loc.lat.toFixed(2)},${loc.lng.toFixed(2)}`;
    if (!byPlace.has(key)) byPlace.set(key, { loc, dates: [] });
    byPlace.get(key)!.dates.push(d.date);
  }
  for (const { loc, dates } of byPlace.values()) {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${dates[0]}&end_date=${dates.at(-1)}`;
      const { daily } = await (await fetch(u)).json();
      daily.time.forEach((date: string, i: number) => {
        if (dates.includes(date)) session.weather[date] = { code: daily.weather_code[i], max: daily.temperature_2m_max[i], min: daily.temperature_2m_min[i] };
      });
    } catch { /* offline or out of range */ }
  }
  if (byPlace.size) renderItinerary();
}
