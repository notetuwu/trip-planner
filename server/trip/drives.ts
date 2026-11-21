// Real road routes between stays the travelers drive (or take a bus) between, so the model plans with facts instead
// of its own idea of geography (a model once called Tunisia to Cape Town undrivable, "different continents").
import type { Trip } from "../ai/types";
import { waitForRoute } from "../geo/routing";

const ROAD = new Set(["car", "bus", "bike"]);

export async function roadRoutes(trip: Trip, onStatus: (s: string) => void): Promise<Trip["drives"]> {
  const legs = trip.stays.map((s, i) => ({ i, a: trip.stays[i - 1], b: s }))
    .filter(({ i, a, b }) => i > 0 && ROAD.has(b.travel || "") && [a?.lat, a?.lng, b.lat, b.lng].every((n) => typeof n === "number"));
  if (!legs.length) return {};
  onStatus("Checking the roads between your stays…");
  const drives: NonNullable<Trip["drives"]> = {};
  for (const { i, a, b } of legs) {
    const r = await waitForRoute("car", [a.lat!, a.lng!], [b.lat!, b.lng!], 25000).catch(() => undefined);
    if (r === null) drives[i] = null;
    else if (r) drives[i] = { km: Math.round(r.d / 1000), hours: Math.round((r.t / 3600) * 10) / 10 };
  }
  return drives;
}

/** "a road route exists: 10,512 km, about 140 h of driving" (or that none was found), for the prompts. */
export function driveNote(trip: Trip, i: number) {
  const d = trip.drives?.[i];
  if (d === undefined) return "";
  if (d === null) return "no road route was found between these places (by a routing service)";
  const days = d.hours > 9 ? `, i.e. at least ${Math.ceil(d.hours / 9)} days at up to ~9 h of driving a day` : "";
  return `a road route exists (checked with a routing service): ${d.km.toLocaleString("en")} km, about ${d.hours < 10 ? d.hours : Math.round(d.hours)} h of driving${days}`;
}
