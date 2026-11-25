// After a plan arrives, wait for the map lookups and opening-hours checks, then send what they found back to the
// model once, so stops in the wrong town or closed at the planned time get fixed before you read the plan.
import type { Itinerary } from "../../../shared/types";
import { state } from "../core/state";
import { fmtDate } from "../core/format";
import { geocodeBusy } from "../geo/geocode";
import { byTitleMap, dayWhere, itemLoc } from "../geo/item-loc";
import { checkOpeningHours, hoursBusy, hoursProblem, hoursResult } from "../itinerary/hours";
import { onWayOf, splitGroup } from "../trip/modes";
import { setMapStatus } from "../map/status";
import { type Stop, cleanStop, findDuplicates, isMeal } from "../itinerary/duplicates";
export type { Stop };

/** `at`: the stop it's about; `with`: for a duplicate, the other copy (which stays). Both 0-based. `key`: a duplicate's
 *  shared name as matched, to mark it fine. */
export interface Problem { day: number; text: string; kind?: "far" | "hours" | "dup"; at?: Stop; with?: Stop; key?: string }

const toMin = (t: string | undefined) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

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
    const next = d.items.slice(xi + 1).find((y) => !g || onWayOf(d.items, y, g) || onWayOf(d.items, x, splitGroup(y)));
    const nextAt = toMin(next?.time);
    if (nextAt != null && nextAt - opens < 30) return;
    x.time = fromMin(opens);
    moved++;
  }));
  return moved;
}

const dayName = (it: Itinerary, i: number) => `Day ${i + 1} (${fmtDate(it.days[i].date) || it.days[i].date})`;

/** A stop planned on two days: the problem is on `replace`'s day, which gets a different place; `keep`'s day keeps it. */
export function duplicateProblem(it: Itinerary, replace: Stop, keep: Stop): Problem {
  const r = it.days[replace[0]].items[replace[1]], k = it.days[keep[0]].items[keep[1]];
  const what = isMeal(r) ? "they already eat there" : "it is also planned";
  return { day: replace[0], kind: "dup", at: replace, with: keep, text: `"${cleanStop(r.place)}" at ${r.time || "?"}: ${what} on ${dayName(it, keep[0])} ("${cleanStop(k.place)}"), which keeps it. Replace this one with a different real place they haven't been to near this day's stops (a must-see or listed place that isn't planned yet, if possible), or drop it. Leave ${dayName(it, keep[0])} as it is.` };
}

/** What the checks currently flag in the plan. */
export function planProblems(it: Itinerary): Problem[] {
  const byTitle = byTitleMap(), out: Problem[] = [];
  it.days.forEach((d, di) => d.items.forEach((x, xi) => {
    if (x.kind === "transfer") return;
    const loc = itemLoc(x, d, byTitle);
    if (loc?.elsewhere) out.push({ day: di, kind: "far", at: [di, xi], text: `"${x.place}" at ${x.time || "?"}: the only place of that name is in ${loc.elsewhere}, far from ${dayWhere(d) || "this day's town"}. Replace it with a real place near the day's town.` });
    const hours = hoursProblem(di, xi);
    if (hours) out.push({ day: di, kind: "hours", at: [di, xi], text: `"${cleanStop(x.place)}" at ${x.time || "?"}: ${hours}. Move it to when it's open (or swap it), or replace it with a similar place that is open.` });
  }));
  // A place on two days: by default the earlier copy is replaced and the later day keeps it (the review can redo either
  // day instead, or mark the repeat as fine).
  for (const { first, again, key } of planDuplicates(it)) out.push({ ...duplicateProblem(it, first, again), key });
  return out;
}

/** Places on more than one day, leaving out those the travelers marked fine to repeat. */
export const planDuplicates = (it: Itinerary) => findDuplicates(it, new Set((state.okRepeats || []).map((r) => r.key)));

/** Marks a repeated place as fine ("name" as shown to them) or, with ok false, as a duplicate again. */
export function setRepeatOk(key: string, name: string, ok: boolean) {
  const list = (state.okRepeats || []).filter((r) => r.key !== key);
  state.okRepeats = ok ? [...list, { key, name }] : list;
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
