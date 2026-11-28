// The Balance window (from the itinerary's toolbar): every day's load side by side (balance.ts), with a bar for each
// number scaled to the trip's largest and what's a lot for these travelers marked. A click on a day goes to it.
import { esc } from "../core/dom";
import { dayColor, fmtDate, fmtDist, fmtDur } from "../core/format";
import { icon } from "../core/icons";
import { groupBudget, state } from "../core/state";
import { byTitleMap } from "../geo/item-loc";
import { distKm } from "../geo/locate";
import { dayLegs, legRoute, requestRoutes } from "../map/routes";
import { type DayLoad, type Heavy, dayLoad, heavy, legLoad, limitsFor } from "./balance";
import { shown } from "./costs-data";

/** Every day's load. `waiting`: legs whose routes were asked for and aren't back yet (the numbers get exact then). */
export function tripLoads(): { loads: DayLoad[]; waiting: number } {
  const byTitle = byTitleMap();
  let waiting = 0;
  const loads = (state.itinerary?.days || []).map((d) => {
    const legs = dayLegs(d, byTitle);
    requestRoutes(legs);
    return dayLoad(d, legs.map((l) => {
      const r = legRoute(l);
      if (r === undefined) waiting++;
      return legLoad(l.mode, distKm({ lat: l.from[0], lng: l.from[1] }, { lat: l.to[0], lng: l.to[1] }), r);
    }));
  });
  return { loads, waiting };
}

const WHY: Record<Heavy, string> = { stops: "a lot of stops for your pace", walk: "a lot of walking for your fitness", ride: "over 3 hours getting around", cost: "over the day's budget" };

export function balanceHtml(): { html: string; hint: string; waiting: number } {
  const it = state.itinerary;
  if (!it?.days.length) return { html: "", hint: "", waiting: 0 };
  const { loads, waiting } = tripLoads();
  const budget = state.meta?.budget || groupBudget(), lim = limitsFor(state.fitness, state.pace, budget), cur = state.currency;
  const max = (f: (l: DayLoad) => number, least: number) => Math.max(least, ...loads.map(f));
  const top = { stops: max((l) => l.stops, lim.stops), walk: max((l) => l.walkKm, lim.walkKm), ride: max((l) => l.rideMin, lim.rideMin), cost: max((l) => l.cost, budget || 1) };
  const cell = (kind: Heavy, value: number, text: string, over: boolean, mark?: number) =>
    `<td class="bal-cell${over ? " over" : ""}"${over ? ` title="${esc(WHY[kind])}"` : ""}><span class="bal-bar"><i style="width:${Math.min(100, (value / top[kind]) * 100).toFixed(1)}%"></i>${mark != null && mark > 0 && mark < top[kind] ? `<u style="left:${((mark / top[kind]) * 100).toFixed(1)}%"></u>` : ""}</span><span class="bal-num">${esc(text)}</span></td>`;
  let flagged = 0;
  const rows = it.days.map((d, i) => {
    const l = loads[i], h = heavy(l, lim);
    if (h.length) flagged++;
    const about = l.rough ? "~" : "";
    return `<tr data-bal-day="${i}" class="${h.length ? "heavy" : ""}" tabindex="0" title="${esc(h.length ? `Stands out: ${h.map((k) => WHY[k]).join(", ")}. Click to go to the day` : "Click to go to the day")}">
      <td><div class="bal-day"><span class="bal-dot" style="--c:${dayColor(i)}">${i + 1}</span><span><b>${esc(fmtDate(d.date))}</b><small>${esc(String(d.city || d.title || ""))}</small></span></div></td>
      ${cell("stops", l.stops, String(l.stops), h.includes("stops"), lim.stops)}
      ${cell("walk", l.walkKm, l.walkKm >= 0.05 ? `${about}${fmtDist(l.walkKm * 1000)}` : "–", h.includes("walk"), lim.walkKm)}
      ${cell("ride", l.rideMin, l.rideMin >= 1 ? `${about}${fmtDur(l.rideMin * 60)}` : "–", h.includes("ride"), lim.rideMin)}
      ${cell("cost", l.cost, shown(l.cost, cur, true), h.includes("cost"), budget)}
      <td class="bal-span">${l.from ? `${esc(l.from)}${l.to !== l.from ? `–${esc(l.to)}` : ""}` : "–"}</td>
    </tr>`;
  }).join("");
  const html = `<div class="balance">
    <p class="hint">Each day's load side by side: bars are relative to the trip's largest, the small line marks what's a lot for you (your pace and fitness under Travelers &amp; style, your budget). Walking and getting around are measured along the map's routes; “~” means some of it is an estimate.</p>
    <table class="bal-table">
      <thead><tr><th>Day</th><th>Stops</th><th>${icon("walk")} Walking</th><th>${icon("route")} Getting around</th><th>${icon("wallet")} Cost</th><th>First–last stop</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  const hint = `${flagged ? `${flagged} day${flagged === 1 ? " stands" : "s stand"} out` : "No day stands out"}${waiting ? ` · measuring ${waiting} route${waiting === 1 ? "" : "s"}…` : ""}`;
  return { html, hint, waiting };
}
