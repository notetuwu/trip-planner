// After a plan arrives, wait for the map lookups and opening-hours checks, then send what they found back to the
// model once, so stops in the wrong town or closed at the planned time get fixed before you read the plan.
import type { Itinerary } from "../../../shared/types";
import { state } from "../core/state";
import { geocodeBusy } from "../geo/geocode";
import { byTitleMap, dayWhere, itemLoc } from "../geo/item-loc";
import { checkOpeningHours, hoursBusy, hoursProblem } from "../itinerary/hours";
import { setMapStatus } from "../map/status";

export interface Problem { day: number; text: string }

const cleanStop = (s: string) => String(s).replace(/\s*\([^)]*\)/g, "").trim();

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
