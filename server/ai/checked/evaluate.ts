// Scores any finished itinerary (from either planner) with the checked planner's deterministic checks, so two plans of
// the same trip can be compared on facts rather than impressions: coverage, must-sees, where the stops are, the time
// between them, overlaps, repeats, closed places, unverified timetables, events outside the stay, cost arithmetic.
// Used by the live test.
import type { Itinerary } from "../../../shared/types";
import type { Holiday } from "../../trip/holidays";
import { spotKey } from "./resolve";
import { type CheckContext, names, validatePlan, visits } from "./validate";

export interface PlanMetrics {
  days: number; expectedDays: number; datesCovered: number;
  /** Stops missing a field the page relies on (time, kind, cost, transport). */
  incompleteStops: number; stops: number;
  /** Where the stops are: found for certain (saved place, OpenStreetMap, the stay, a lookup by name), roughly, or not at all. */
  located: { fixed: number; rough: number; none: number };
  mustSee: { total: number; planned: number; inUnused: number; silentlyMissing: number };
  hopsRouted: number; noTimeBetween: number;
  overlaps: number; outOfOrder: number; duplicates: number; travelDayOverload: number; dayTripsOnTravelDays: number;
  emptyDays: number; closedThen: number; carInTown: number; needlessTransfers: number;
  unverifiedSchedules: number; eventsOutsideStay: number; holidaysElsewhere: number;
  /** Days whose stated total isn't the sum of their stops' costs. */
  costMismatches: number; unknownCosts: number;
  hasLocalCurrency: boolean; hasUnused: boolean;
  issues: Record<string, number>;
}

const FIELDS = ["time", "kind", "cost", "transport"] as const;

export function evaluatePlan(it: Itinerary, ctx: CheckContext, holidays: Holiday[] = []): PlanMetrics {
  const issues = validatePlan(it.days, ctx);
  const count = (code: string) => issues.filter((x) => x.code === code).length;
  const by = issues.reduce<Record<string, number>>((m, x) => ({ ...m, [x.code]: (m[x.code] || 0) + 1 }), {});
  const stops = it.days.flatMap((d) => d.items);
  const planned = ctx.mustSee.filter((t) => it.days.some((d) => visits(d, t)));
  const unused = ctx.mustSee.filter((t) => !planned.includes(t) && (it.unused || []).some((u) => names(u.place, t)));
  // Holidays mentioned on a day (in its notes or the trip's events) in a country they aren't in that day.
  const frameOf = new Map(ctx.frames.map((f) => [f.date, f]));
  const elsewhere = holidays.filter((h) => !frameOf.get(h.date)?.countries.includes(h.cc.toUpperCase())).filter((h) => {
    const words = [h.name, h.localName].filter(Boolean) as string[];
    const said = (s?: string) => !!s && words.some((w) => s.toLowerCase().includes(w.toLowerCase().split(/[ (]/).slice(0, 2).join(" ")));
    return said(it.days.find((d) => d.date === h.date)?.notes) || (it.holidaysAndEvents || []).some((e) => said(e.name));
  }).length;
  const first = ctx.frames[0]?.date || "", last = ctx.frames.at(-1)?.date || "";
  const outside = (it.holidaysAndEvents || []).filter((e) => { const [a, b = a] = String(e.date || "").split(".."); return /^\d{4}-/.test(a) && (b < first || a > last); }).length;
  const located = { fixed: 0, rough: 0, none: 0 };
  for (const d of it.days) d.items.forEach((x, i) => { const s = ctx.located?.get(spotKey(d.date, i)); if (!s) located.none++; else if (s.how === "near") located.rough++; else located.fixed++; });
  return {
    days: it.days.length, expectedDays: ctx.frames.length, datesCovered: ctx.frames.filter((f) => it.days.some((d) => d.date === f.date)).length,
    stops: stops.length, incompleteStops: stops.filter((x) => FIELDS.some((k) => (x as any)[k] == null || (x as any)[k] === "")).length,
    located,
    mustSee: { total: ctx.mustSee.length, planned: planned.length, inUnused: unused.length, silentlyMissing: ctx.mustSee.length - planned.length - unused.length },
    hopsRouted: Object.keys(ctx.hops || {}).length, noTimeBetween: count("no-time-between"),
    overlaps: count("overlap"), outOfOrder: count("order"), duplicates: count("duplicate-place") + count("duplicate-restaurant"),
    travelDayOverload: count("travel-day-heavy"), dayTripsOnTravelDays: count("day-trip-on-travel-day"),
    emptyDays: count("full-day-empty") + count("empty-day"), closedThen: count("closed-then"), carInTown: count("car-in-town"), needlessTransfers: count("needless-transfer"),
    unverifiedSchedules: count("unverified-schedule"), eventsOutsideStay: outside, holidaysElsewhere: elsewhere,
    costMismatches: it.days.filter((d) => Math.abs((Number(d.estimatedCost) || 0) - d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0)) > 0.5).length,
    unknownCosts: count("cost-unknown"),
    hasLocalCurrency: !!it.localCurrency, hasUnused: Array.isArray(it.unused),
    issues: by,
  };
}
