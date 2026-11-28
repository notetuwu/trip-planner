// How much each day of the plan asks of them, side by side: stops, walking, time spent getting around, cost, and how
// long the day runs, so the overloaded day stands out before the trip (the Balance window, sections.ts). Plain data in,
// no page: the legs come from the map's routes (map/routes.ts), measured along real paths and roads where known and
// estimated from the straight distance where not.
import type { Day } from "../../../shared/types";

/** One leg of a day as it counts here: how far and how long, and whether that is measured or estimated. */
export interface LegLoad { mode: string; km: number; mins: number; routed: boolean }

/** Speeds (km/h) and detour factors for a leg with no route yet, by how it's travelled. */
const GUESS: Record<string, { kmh: number; detour: number; wait?: number }> = {
  foot: { kmh: 4.5, detour: 1.3 }, bike: { kmh: 14, detour: 1.3 }, car: { kmh: 50, detour: 1.3 }, transit: { kmh: 22, detour: 1.3, wait: 8 },
  train: { kmh: 80, detour: 1.2, wait: 10 }, ferry: { kmh: 28, detour: 1.05, wait: 15 }, lift: { kmh: 15, detour: 1 }, flight: { kmh: 700, detour: 1, wait: 120 },
  straight: { kmh: 40, detour: 1.2 },
};

/** A leg's load: the route's distance (m) and time (s) when there is one, else a guess from the straight distance. */
export function legLoad(mode: string, straightKm: number, route?: { d: number; t: number } | null): LegLoad {
  if (route) return { mode, km: route.d / 1000, mins: route.t / 60, routed: true };
  const g = GUESS[mode] || GUESS.straight, km = straightKm * g.detour;
  return { mode, km, mins: (km / g.kmh) * 60 + (g.wait || 0), routed: false };
}

export interface DayLoad {
  /** Stops that aren't just getting somewhere (meals count: they take time too). */
  stops: number;
  walkKm: number;
  /** Minutes in a car, on a train, bus, boat… (not on foot). */
  rideMin: number;
  cost: number;
  /** When the first stop starts and the last one starts ("" when no times). */
  from: string;
  to: string;
  /** Some of the day's legs are estimates (not routed yet, or no route exists). */
  rough: boolean;
}

const HHMM = /^(\d{1,2}):(\d{2})/;

export function dayLoad(d: Day, legs: LegLoad[]): DayLoad {
  const times = d.items.map((x) => HHMM.exec(x.time || "")).filter((m): m is RegExpExecArray => !!m).map((m) => `${m[1].padStart(2, "0")}:${m[2]}`).sort();
  return {
    stops: d.items.filter((x) => x.kind !== "transfer").length,
    walkKm: legs.filter((l) => l.mode === "foot").reduce((n, l) => n + l.km, 0),
    rideMin: legs.filter((l) => l.mode !== "foot").reduce((n, l) => n + l.mins, 0),
    cost: Number(d.estimatedCost) || 0,
    from: times[0] || "", to: times.at(-1) || "",
    rough: legs.some((l) => !l.routed),
  };
}

export interface Limits { walkKm: number; rideMin: number; stops: number; budget: number }

/** What's a lot for these travelers: walking by their fitness, stops by their pace, cost by their budget. */
export function limitsFor(fitness: string | undefined, pace: string | undefined, budget: number): Limits {
  const walkKm = fitness === "easy" ? 6 : fitness === "fit" ? 16 : 10;
  const p = String(pace || "");
  const stops = p.startsWith("relaxed") ? 6 : p.startsWith("packed") ? 11 : 8;
  return { walkKm, rideMin: 180, stops, budget };
}

export type Heavy = "stops" | "walk" | "ride" | "cost";

/** Which of a day's numbers stand out: over what's a lot for them. */
export function heavy(l: DayLoad, lim: Limits): Heavy[] {
  return [
    l.stops > lim.stops ? "stops" as const : null,
    l.walkKm > lim.walkKm ? "walk" as const : null,
    l.rideMin > lim.rideMin ? "ride" as const : null,
    lim.budget > 0 && l.cost > lim.budget * 1.1 ? "cost" as const : null,
  ].filter((x): x is Heavy => !!x);
}
