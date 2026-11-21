// Hover tooltips for route lines, and the "1.2 km · 15 min walk" line under each stop.
import * as L from "leaflet";
import type { Day, LatLng, Route } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { fmtDate, fmtDist, fmtDur } from "../core/format";
import { state } from "../core/state";
import { byTitleMap, dayWhere, itemLoc } from "../geo/item-loc";
import { distKm } from "../geo/locate";
import { cleanStop, splitGroup } from "../trip/modes";
import { type Leg, dayLegs, legRoute } from "./routes";
import { icon } from "../core/icons";

const crowMetres = (from: LatLng, to: LatLng) => distKm({ lat: from[0], lng: from[1] }, { lat: to[0], lng: to[1] }) * 1000;

/** A wide, invisible line over a route so thin or dotted lines are easy to hover; the visible line thickens meanwhile. */
export function hoverBand(line: LatLng[], tip: string, vis: L.Polyline) {
  const w = vis.options.weight!, o = vis.options.opacity!;
  // Clicks stay on the line (which jumps to the stop in the list) instead of reaching the map's "add a place" click.
  return L.polyline(line, { weight: 16, opacity: 0, lineCap: "round", bubblingMouseEvents: false })
    .bindTooltip(tip, { sticky: true, className: "leg-tip" })
    .on("mouseover", () => vis.setStyle({ weight: w + 3, opacity: 1 }))
    .on("mouseout", () => vis.setStyle({ weight: w, opacity: o }));
}

/** Hover text for a day's leg: which day, from where to where, how, and how far. */
export function legTip(d: Day, leg: Leg, r: Route | null | undefined) {
  const a = d.items[leg.fromXi], b = d.items[leg.xi], t = b.transport || "";
  const how = leg.mode === "foot" ? `${icon("walk")} walk` : leg.mode === "car" ? `${icon("car")} by road`
    : /flight|fly|plane/i.test(t) ? `${icon("plane")} flight` : /ferry|boat|ship|vaporetto/i.test(t) ? `${icon("ship")} boat` : `${icon("train")} rail / transit`;
  const dist = r ? `${fmtDist(r.d)} · ${fmtDur(r.t)}` : `${fmtDist(crowMetres(leg.from, leg.to))} straight line`;
  const g = splitGroup(b);
  return `<b>${esc(fmtDate(d.date))}</b>${g ? ` · ${esc(g)}` : ""}<br>${leg.fromXi + 1}. ${esc(a.place)} → ${leg.xi + 1}. ${esc(b.place)}<br>` +
    `<span class="pop-meta">${how} · ${dist}${t ? `<br>${esc(t)}` : ""}</span>`;
}

/** Fills each stop's leg line and the warning for places that turned out to be far from their day. */
export function updateLegInfo() {
  const it = state.itinerary; if (!it) return;
  const byTitle = byTitleMap();
  it.days.forEach((d, di) => {
    d.items.forEach((x, xi) => {
      const el = $(`[data-far="${di}-${xi}"]`); if (!el) return;
      const loc = itemLoc(x, d, byTitle);
      el.hidden = !loc?.elsewhere;
      if (loc?.elsewhere) el.innerHTML = `${icon("warn")} The only "${cleanStop(x.place)}" known is far away (${esc(loc.elsewhere)}), not near ${esc(dayWhere(d) || "this day's town")}. Probably a mix-up by the AI; pinned in town for now.`;
    });
    for (const leg of dayLegs(d, byTitle)) {
      const el = $(`[data-leg="${di}-${leg.xi}"]`);
      if (!el) continue;
      const r = legRoute(leg);
      el.textContent = r ? `${fmtDist(r.d)} · ${fmtDur(r.t)} ${leg.mode === "foot" ? "walk" : "by road"}`
        : leg.mode === "straight" || r === null ? `${fmtDist(crowMetres(leg.from, leg.to))} as the crow flies` : "";
    }
  });
}
