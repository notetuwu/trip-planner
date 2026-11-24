// Hover tooltips for route lines, and the "1.2 km · 15 min walk" line under each stop.
import * as L from "leaflet";
import type { Day, LatLng, Route } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { fmtDate, fmtDist, fmtDur } from "../core/format";
import { state } from "../core/state";
import { byTitleMap, dayWhere, itemLoc } from "../geo/item-loc";
import { distKm } from "../geo/locate";
import { cleanStop, splitGroup } from "../trip/modes";
import { type Leg, dayLegs, legRoute, legStart } from "./routes";
import { type IconName, icon } from "../core/icons";

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

/** How a leg goes, in words and with its icon. A straight line is named from the text (by air, else by rail). */
const MODE_WORDS: Record<string, [IconName, string]> = {
  foot: ["walk", "walk"], bike: ["bike", "by bike"], car: ["car", "by road"], transit: ["tram", "by tram, metro or bus"], train: ["train", "by train"],
  ferry: ["ship", "by boat"], lift: ["cableCar", "by cable car"], flight: ["plane", "flight"],
};
function modeWords(leg: Leg, transport: string): [IconName, string] {
  if (leg.bus) return ["bus", "by bus"];
  if (leg.mode === "transit") return /\b(trams?|streetcar|light rail)\b/i.test(transport) ? ["tram", "by tram"] : /\b(metro|subway|u-?bahn|underground|tube)\b/i.test(transport) ? ["train", "by metro"] : MODE_WORDS.transit;
  return MODE_WORDS[leg.mode] || (/flight|fly|plane/i.test(transport) ? MODE_WORDS.flight : ["train", "by rail"]);
}

/** Hover text for a day's leg: which day, from where to where, how, and how far. */
export function legTip(d: Day, leg: Leg, r: Route | null | undefined) {
  const b = d.items[leg.xi], t = b.transport || "";
  const start = leg.fromXi >= 0 ? `${leg.fromXi + 1}. ${esc(legStart(d, leg))}` : `${icon("bed")} ${esc(legStart(d, leg))}`;
  const [ic, words] = modeWords(leg, t), how = `${icon(ic)} ${words}`;
  const dist = r ? `${fmtDist(r.d)} · ${fmtDur(r.t)}` : `${fmtDist(crowMetres(leg.from, leg.to))}${leg.mode === "flight" ? "" : " straight line"}`;
  const g = splitGroup(b);
  return `<b>${esc(fmtDate(d.date))}</b>${g ? ` · ${esc(g)}` : ""}<br>${start} → ${leg.xi + 1}. ${esc(b.place)}<br>` +
    `<span class="pop-meta">${how} · ${dist}${t ? `<br>${esc(t)}` : ""}</span>`;
}

/** "1.2 km · 15 min walk", "19 km · 1 h by boat", "4 km as the crow flies"; "" while it's still being routed. A part of
 *  a longer leg says how it goes even when it's a straight line ("4.5 km by rail"). */
function legLine(leg: Leg, transport: string, part: boolean) {
  const r = legRoute(leg), how = modeWords(leg, transport)[1];
  if (r) return `${fmtDist(r.d)} · ${fmtDur(r.t)} ${how}`;
  if (leg.mode === "flight") return `${fmtDist(crowMetres(leg.from, leg.to))} ${how}`;
  // Not routed: the distance as the crow flies, saying how they go when the map knows (a boat with no route found).
  if (leg.mode === "straight" || r === null) return `${fmtDist(crowMetres(leg.from, leg.to))} ${part || leg.mode !== "straight" ? `${how} (straight line)` : "as the crow flies"}`;
  return "";
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
    // A leg in parts (rail down to Vitznau, then the boat): one line, "4.5 km by rail + 19 km · 1 h 5 min by boat".
    const byStop = new Map<number, Leg[]>();
    for (const leg of dayLegs(d, byTitle)) byStop.set(leg.xi, [...(byStop.get(leg.xi) || []), leg]);
    for (const [xi, legs] of byStop) {
      const el = $(`[data-leg="${di}-${xi}"]`);
      if (!el) continue;
      el.textContent = legs.map((leg) => legLine(leg, d.items[xi].transport || "", legs.length > 1)).filter(Boolean).join(" + ");
    }
  });
}
