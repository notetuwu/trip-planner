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
import type { Ride } from "../../../shared/types";
import { compareRides, kindsAgree, rideKind, rideName, ridesText } from "../../../shared/rides";
import { isTransfer } from "./travel-day";
import { save } from "../core/state";

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
    `<span class="pop-meta">${how} · ${dist}${t ? `<br>${esc(t)}` : ""}</span>${r?.rides?.length ? `<div class="ride-tips">${ridesHtml(r.rides, leg.mode)}</div>` : ""}`;
}

/** A ride's line badge: its number on its colour (the operator's, else the kind's own). */
const KIND_COLOUR: Record<string, string> = { Bus: "#1565c0", Tram: "#c62828", Metro: "#6a1b9a", Train: "#37474f", Boat: "#0277bd", "Cable car": "#6d4c41", Funicular: "#6d4c41" };
export const rideColour = (r: Ride) => r.colour || KIND_COLOUR[rideKind(r.mode, "", r.agency)] || "#37474f";
const KIND_ICON: Record<string, IconName> = { Bus: "bus", Tram: "tram", Metro: "train", Train: "train", Boat: "ship", "Cable car": "cableCar", Funicular: "cableCar" };
export const rideIcon = (r: Ride): IconName => KIND_ICON[rideKind(r.mode, "", r.agency)] || "train";
/** A stop to click: the map goes there. */
const stopBtn = (s: { n: string; lat: number; lng: number }) => `<button type="button" class="ride-stop" data-goto="${s.lat},${s.lng}" data-goto-name="${esc(s.n)}" title="Show on the map">${esc(s.n || "Stop")}</button>`;

/** The rides of a leg, one a line: badge, name, direction, where on and off, stops, when it leaves. */
export function ridesHtml(rides: Ride[], legMode = "") {
  return rides.map((r) => {
    const kind = rideKind(r.mode, legMode, r.agency), n = r.stops.length + 1;
    const badge = `<span class="line-chip" style="--c:${esc(rideColour(r))}">${r.line ? esc(r.line) : icon(KIND_ICON[kind] || "train")}</span>`;
    // After the badge: the line's full name, or the operator when there's no name (Osaka Metro gives only that).
    const name = r.line ? (r.name && !r.name.includes(r.line) ? r.name : "") : r.name || r.agency || "";
    // Where to get on and off can be clicked (the map goes there); the stops in between open from their count.
    // (Last on the line, so the list opens under it without breaking it.)
    const all = r.stops.length ? `<details class="ride-all"><summary>${n} stops</summary><span class="ride-list">${r.stops.map(stopBtn).join("")}</span></details>` : `${n} stop`;
    return `<div class="ride">${badge}<span><b>${esc(kind)}${name ? ` ${esc(name)}` : ""}</b>${r.to ? ` towards ${esc(r.to)}` : ""}<br><span class="ride-meta">${stopBtn(r.on)} → ${stopBtn(r.off)}${r.dep ? ` · leaves ${esc(r.dep)}` : ""} · ${all}</span></span></div>`;
  }).join("");
}

/** A stop of a ride clicked (in the itinerary or a tooltip): the map goes there and says which it is. */
export function initRideStops(goTo: (lat: number, lng: number, name: string) => void) {
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-goto]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const [lat, lng] = b.dataset.goto!.split(",").map(Number);
    goTo(lat, lng, b.dataset.gotoName || "");
  });
}

/** A function to call when the plan's words were changed from the timetable (the itinerary is drawn again). */
let onPlanChanged: () => void = () => {};
export const setOnPlanChanged = (fn: () => void) => { onPlanChanged = fn; };

/**
 * The timetable's line where the plan names another one, or none: the stop's words for how they get here become the
 * timetable's ("Bus 5 towards Kriens: Luzern, Moosegg → Kriens, Busschleife, 9 stops"), the old ones kept. Only on train,
 * tram, metro and bus legs (a boat's or a gondola's own words say more), only once per stop, and never for a stop whose
 * way they set themselves. True when something changed.
 */
function takeTimetable(x: Day["items"][number], legs: Leg[], transfers: Day["items"]): boolean {
  if (x.transportWas !== undefined || x.leg || transfers.some((t) => t.transportWas !== undefined)) return false;
  const ridden = legs.filter((l) => l.mode === "train" || l.mode === "transit");
  const rides = ridden.flatMap((l) => legRoute(l)?.rides || []);
  // A transfer on the way ("Kriens → Lucerne (bus 5)") names the line in its own name.
  const said = [...transfers.map((t) => t.place), x.transport || ""].join(" ");
  if (!rides.length || !kindsAgree(said, rides, ridden[0].mode) || compareRides(said, rides) === "same") return false;
  const text = ridesText(rides, ridden[0].mode);
  // There, the brackets get the timetable's lines ("Kriens → Lucerne (Bus 31, then Bus 1, then Bus 7)").
  const named = transfers.find((t) => /\(([^)]*)\)/.test(t.place) && compareRides(t.place, rides) !== "none");
  if (named) {
    named.transportWas = named.place;
    named.place = named.place.replace(/\s*\(([^)]*)\)/, ` (${rides.map((r) => rideName(r, ridden[0].mode)).join(", then ")})`);
    return true;
  }
  x.transportWas = x.transport || "";
  x.transport = text;
  return true;
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
  let updated = 0;
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
      // Transfers on the way to this stop (not on the map themselves: this leg is their trip).
      const fromXi = Math.min(...legs.map((l) => l.fromXi)), g = splitGroup(d.items[xi]);
      const transferXis = d.items.map((y, k) => k).filter((k) => k > fromXi && k < xi && isTransfer(d.items[k]) && (!splitGroup(d.items[k]) || !g || splitGroup(d.items[k]) === g));
      if (takeTimetable(d.items[xi], legs, transferXis.map((k) => d.items[k]))) updated++;
      const el = $(`[data-leg="${di}-${xi}"]`);
      if (!el) continue;
      const text = legs.map((leg) => legLine(leg, d.items[xi].transport || "", legs.length > 1)).filter(Boolean).join(" + ");
      // With the rides of a public transport leg: which line, towards where, on and off, how many stops. Under the
      // transfer when there is one (that's where the plan describes the trip), else under the stop.
      const rides = legs.flatMap((leg) => (legRoute(leg)?.rides || []).map((r) => ({ r, mode: leg.mode })));
      const ridesBox = rides.length ? `<div class="rides">${rides.map(({ r, mode }) => ridesHtml([r], mode)).join("")}</div>` : "";
      const at = transferXis.length ? $(`[data-leg="${di}-${transferXis.at(-1)}"]`) : null;
      if (at) at.innerHTML = ridesBox;
      el.innerHTML = `${esc(text)}${at ? "" : ridesBox}`;
    }
  });
  if (updated) { save(); onPlanChanged(); }
}
