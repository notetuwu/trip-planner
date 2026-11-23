// After a plan arrives, wait for the map lookups and opening-hours checks, then send what they found back to the
// model once, so stops in the wrong town or closed at the planned time get fixed before you read the plan.
import type { Itinerary } from "../../../shared/types";
import { state } from "../core/state";
import { geocodeBusy } from "../geo/geocode";
import { byTitleMap, dayWhere, itemLoc } from "../geo/item-loc";
import { checkOpeningHours, hoursBusy, hoursProblem, hoursResult } from "../itinerary/hours";
import { splitGroup } from "../trip/modes";
import { setMapStatus } from "../map/status";

export interface Problem { day: number; text: string }

const cleanStop = (s: string) => String(s).replace(/\s*\([^)]*\)/g, "").trim();
const toMin = (t: string | undefined) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const isMeal = (x: { kind?: string; place: string }) => x.kind === "meal" || /^(breakfast|brunch|lunch|dinner)\b/i.test(x.place);
/** A place's name for spotting repeats: no accents, case, brackets or punctuation. */
const key = (s: string) => cleanStop(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Fixes that need no model: a stop planned a little before it opens (breakfast at 7:30 at a café that opens at 8:00)
 * moves to the opening time, as long as that still leaves half an hour before the next stop. Returns how many moved.
 */
export function quickFixes(it: Itinerary): number {
  let moved = 0;
  it.days.forEach((d, di) => d.items.forEach((x, xi) => {
    const r = hoursResult(di, xi), opens = toMin(r?.opens), start = toMin(x.time);
    if (r?.status !== "opens-later" || opens == null || start == null || opens <= start) return;
    const g = splitGroup(x);
    const next = d.items.slice(xi + 1).find((y) => !splitGroup(y) || !g || splitGroup(y) === g);
    const nextAt = toMin(next?.time);
    if (nextAt != null && nextAt - opens < 30) return;
    x.time = fromMin(opens);
    moved++;
  }));
  return moved;
}

/** What the checks currently flag in the plan. */
export function planProblems(it: Itinerary): Problem[] {
  const byTitle = byTitleMap(), out: Problem[] = [];
  it.days.forEach((d, di) => d.items.forEach((x, xi) => {
    if (x.kind === "transfer") return;
    const loc = itemLoc(x, d, byTitle);
    if (loc?.elsewhere) out.push({ day: di, text: `"${x.place}" at ${x.time || "?"}: the only place of that name is in ${loc.elsewhere}, far from ${dayWhere(d) || "this day's town"}. Replace it with a real place near the day's town.` });
    const hours = hoursProblem(di, xi);
    if (hours) out.push({ day: di, text: `"${cleanStop(x.place)}" at ${x.time || "?"}: ${hours}. Move it to when it's open (or swap it), or replace it with a similar place that is open.` });
  }));
  // The same restaurant or café on more than one day (unless they asked for it, the plan should vary): the later visits.
  const firstVisit = new Map<string, number>();
  it.days.forEach((d, di) => d.items.forEach((x) => {
    if (!isMeal(x) || /^(breakfast|brunch|lunch|dinner)\b/i.test(cleanStop(x.place)) || /hotel/i.test(x.place)) return;
    const k = key(x.place);
    if (!k) return;
    const at = firstVisit.get(k);
    if (at == null) firstVisit.set(k, di);
    else if (at !== di) out.push({ day: di, text: `"${cleanStop(x.place)}" at ${x.time || "?"}: they already eat there on ${it.days[at].date}. Pick a different real place near this day's stops (from the lists above if possible).` });
  }));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the lookups and hours checks are done (or up to maxMs); false if the plan changed meanwhile. */
export async function checksSettled(it: Itinerary, maxMs = 180_000) {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < maxMs) {
    if (state.itinerary !== it) return false;
    checkOpeningHours();
    quiet = !geocodeBusy() && !hoursBusy() ? quiet + 1 : 0;
    if (quiet >= 3) return true;
    if (!geocodeBusy()) setMapStatus("Checking the plan against the map…");
    await sleep(1000);
  }
  return state.itinerary === it;
}
