// "Stops on the way": overnight stops between two stays for a long drive. The real road route gives where each day's
// driving ends; the selected model picks a good town near each of those points (or the towns themselves are used).
import type { LatLng } from "../../shared/types";
import { askModel } from "../ai/ask";
import { parseJsonLoose } from "../ai/output";
import { errMsg } from "../config";
import { nominatim } from "../geo/providers";
import { waitForRoute } from "../geo/routing";
import type { Report } from "../util/progress-stream";

export interface StopsRequest {
  from: { city: string; lat: number; lng: number };
  to: { city: string; lat: number; lng: number };
  hoursPerDay: number;
  mode?: string;
  model: string;
  travelers?: number;
  interests?: string;
}
export interface SuggestedStop { city: string; country?: string; nights: number; why?: string }
export interface StopsResult { km: number; hours: number; stops: SuggestedStop[]; picked: "model" | "route"; note?: string }

const R = Math.PI / 180;
const km = (a: LatLng, b: LatLng) => {
  const x = (b[1] - a[1]) * R * Math.cos((a[0] + b[0]) * R / 2), y = (b[0] - a[0]) * R;
  return Math.sqrt(x * x + y * y) * 6371;
};

/** Points at the given fractions of the route's length. */
export function pointsAlong(line: LatLng[], fractions: number[]): LatLng[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + km(line[i - 1], line[i]));
  const total = cum.at(-1)!;
  return fractions.map((f) => {
    const target = f * total;
    const i = Math.max(1, cum.findIndex((c) => c >= target));
    const seg = cum[i] - cum[i - 1] || 1, t = (target - cum[i - 1]) / seg;
    return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
  });
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(",")[0].trim();
/** The start or the destination itself (the model sometimes lists them too). */
const sameTown = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); };

/** The town at a point (city level), in English. */
async function townAt([lat, lng]: LatLng) {
  try {
    const hit = await nominatim("reverse", new URLSearchParams({ lat: String(lat), lon: String(lng), format: "jsonv2", zoom: "10", addressdetails: "1", "accept-language": "en" }));
    const a = hit?.address || {};
    const name = String(a.city || a.town || a.village || a.municipality || a.county || a.state_district || a.state || "")
      .replace(/\s+(local municipality|municipality|district|ward|county|governorate|region|zone)$/i, "").trim();
    return name ? { name, country: a.country || "" } : null;
  } catch { return null; }
}

export async function suggestStops(req: StopsRequest, report: Report = () => {}, signal?: AbortSignal): Promise<StopsResult> {
  report({ type: "status", text: `Finding the road from ${req.from.city} to ${req.to.city}…` });
  const from: LatLng = [req.from.lat, req.from.lng], to: LatLng = [req.to.lat, req.to.lng];
  const route = await waitForRoute("car", from, to, 45000);
  if (route === null) throw new Error(`No road route was found between ${req.from.city} and ${req.to.city}.`);
  if (!route) throw new Error("The routing service is slow right now; try again in a minute.");
  const dist = Math.round(route.d / 1000);
  // Cycling: a car route's time means little, so go by distance (~18 km/h on the bike).
  const hours = req.mode === "bike" ? dist / 18 : (route.t / 3600) * (req.mode === "bus" ? 1.2 : 1);
  const perDay = Math.min(14, Math.max(2, Number(req.hoursPerDay) || 6));
  const days = Math.ceil(hours / perDay - 0.1);
  if (days <= 1) return { km: dist, hours, stops: [], picked: "route", note: `It's about ${Math.round(hours * 10) / 10} h, so it fits in one day.` };

  const points = pointsAlong(route.c, Array.from({ length: days - 1 }, (_, k) => (k + 1) / days));
  const towns: { name: string; country: string; afterHours: number }[] = [];
  for (const [k, p] of points.entries()) {
    report({ type: "status", text: `${dist.toLocaleString("en")} km, about ${Math.round(hours)} h. Finding where each day ends (${k + 1} of ${points.length})…` });
    const t = await townAt(p);
    if (t) towns.push({ ...t, afterHours: Math.round(((k + 1) * hours) / days) });
  }
  const fallback: StopsResult = { km: dist, hours, picked: "route", stops: towns.map((t) => ({ city: t.name, country: t.country, nights: 1, why: `About ${t.afterHours} h of driving from ${req.from.city}.` })) };

  const prompt = `Travelers are going from ${req.from.city} to ${req.to.city} ${req.mode === "bike" ? "by bike" : req.mode === "bus" ? "by bus" : "by car"}: ${dist.toLocaleString("en")} km, about ${Math.round(hours)} h of ${req.mode === "bike" ? "cycling" : "driving"} (from a routing service). They want to travel at most about ${perDay} h a day.
${req.travelers ? `Travelers: ${req.travelers}. ` : ""}Interests: ${req.interests || "none given"}.

Along the road route, each day of travel ends near:
${towns.map((t, k) => `${k + 1}. ${t.name}, ${t.country} (about ${t.afterHours} h from ${req.from.city})`).join("\n")}

Choose the overnight stops between them, in travel order (not ${req.from.city} or ${req.to.city} themselves: they are already stays). Near each point above, pick the best real town or city on or close to the route for a night: somewhere with places to stay and something worth seeing, preferring well-known highlights when one is close (shift a day a bit shorter or longer to reach it). Give a highlight 2 nights when it's worth a rest day. Keep every day within about ${perDay + 1} h of travel. Mention border crossings or long empty stretches in "why" when they matter.
Reply with only JSON: {"stops": [{"city": "...", "country": "...", "nights": 1, "why": "one short sentence"}]}`;

  try {
    report({ type: "status", text: `Choosing towns for ${towns.length} night${towns.length > 1 ? "s" : ""} on the way…` });
    const parsed = parseJsonLoose(await askModel(req.model, prompt, (n) => report({ type: "tokens", n }), { signal }));
    const stops = (Array.isArray(parsed?.stops) ? parsed.stops : [])
      .filter((s: any) => s && typeof s.city === "string" && s.city.trim() && !sameTown(s.city, req.from.city) && !sameTown(s.city, req.to.city))
      .slice(0, 40)
      .map((s: any) => ({ city: s.city.trim(), country: String(s.country || "").trim(), nights: Math.min(3, Math.max(1, Math.round(Number(s.nights) || 1))), why: String(s.why || "").slice(0, 200) }));
    if (stops.length) return { km: dist, hours, stops, picked: "model" };
    return { ...fallback, note: "The model didn't suggest stops, so these are the towns where each day ends." };
  } catch (e) {
    return { ...fallback, note: `The model couldn't help (${errMsg(e).slice(0, 120)}), so these are the towns where each day ends.` };
  }
}
