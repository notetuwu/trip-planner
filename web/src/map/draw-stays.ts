// Stays on the map: numbered pins, the legs between them (driven ones along the road), and day trips.
import * as L from "leaflet";
import type { LatLng, RouteMode, TravelMode } from "../../../shared/types";
import { mapsName } from "../core/maps-links";
import { esc } from "../core/dom";
import { addDays, fmtDate, fmtDist, fmtDur } from "../core/format";
import { session, state } from "../core/state";
import { geo, geoKey } from "../geo/geocode";
import { distKm, placeLoc, stayLoc, stayMapsUrl } from "../geo/locate";
import { mustSeeRoute } from "../places/route";
import { cleanStop, dayGroupColors, modeIcon, modeName, plannedMode, splitGroup } from "../trip/modes";

/** The colour (--track-N) of the split group that goes on a day trip (its stops or transfers name the place), as on
 *  that day; "" when everyone goes. */
function tripGroup(place: string): { g: string; color: string } {
  const name = place.split(",")[0].trim().toLowerCase();
  if (!name) return { g: "", color: "" };
  const days = state.itinerary?.days || [];
  for (let di = 0; di < days.length; di++) for (const x of days[di].items) {
    const g = splitGroup(x);
    if (g && cleanStop(x.place).toLowerCase().includes(name)) return { g, color: cssVar(`--track-${dayGroupColors(days[di].items, di)[g]}`) };
  }
  return { g: "", color: "" };
}
import { hoverBand } from "./legs";
import { focusStay } from "../trip/stays";
import { cssVar, layers } from "./map";
import { flightArc, requestRoutes, routeKey, routes } from "./routes";
import { icon } from "../core/icons";
import { byTitleMap } from "../geo/item-loc";
import { type ViaStop, stayLegOwned, viaStops } from "./travel-day";

/** `i`: the stay it arrives at (or the stay a day trip starts from), for jumping to it in the list. */
/** The plan has the travel day into stay i (then its stops are the way; otherwise the must-sees on the leg are). */
const planned = (i: number) => !!state.itinerary?.days.some((d) => d.date === state.stays[i].start);

export interface StayLeg { i: number; from: LatLng; to: LatLng; mode?: TravelMode; label: string; trip?: boolean; place?: string; via?: ViaStop[] }

/**
 * The must-sees to pass on the drive into stay i, before there's a plan for that day: the ones they want "on the way"
 * on this leg, or that lie on it (unless they want them from a stay). In order along the way, so the road route goes
 * through them (over the Penser Joch, not round it on the motorway).
 */
function mustSeesOnLeg(i: number): ViaStop[] {
  const a = stayLoc(state.stays[i - 1]), b = stayLoc(state.stays[i]);
  if (!a || !b) return [];
  const from = state.stays[i - 1].city, to = state.stays[i].city;
  return Object.keys(state.marks).filter((t) => state.marks[t] === "must").flatMap((title) => {
    const r = mustSeeRoute(title), p = session.places.find((x) => x.title === title), loc = p && placeLoc(p);
    if (!r?.leg || !loc || r.leg.from !== from || r.leg.to !== to) return [];
    const wanted = r.how === "way" ? !(r.trip && r.onTrip) : r.how !== "stay" && r.onWay;
    return wanted ? [{ xi: -1, name: title, loc: [loc.lat, loc.lng] as LatLng, d: distKm(a, loc) }] : [];
  }).sort((x, y) => x.d - y.d).map(({ d: _, ...v }) => v);
}

export function stayLegs(): StayLeg[] {
  const legs: StayLeg[] = [], byTitle = byTitleMap();
  state.stays.forEach((s, i) => {
    const here = stayLoc(s); if (!here) return;
    const prev = i > 0 ? stayLoc(state.stays[i - 1]) : null;
    if (prev) legs.push({ i, from: [prev.lat, prev.lng], to: [here.lat, here.lng], mode: s.travel || plannedMode(state.stays[i - 1].city, s.city), label: `${state.stays[i - 1].city} → ${s.city}`, via: planned(i) ? viaStops(i, byTitle) : mustSeesOnLeg(i) });
    for (const t of s.dayTrips || []) {
      const g = t.place ? geo[geoKey(t.place)] : null;
      // A day trip found hundreds of km away is a wrong match for its name, not somewhere to go and back in a day.
      if (g && distKm(here, g) < 400) legs.push({ i, from: [here.lat, here.lng], to: [g.lat, g.lng], mode: t.mode || plannedMode(s.city, t.place), label: `Day trip: ${s.city} ↔ ${t.place}`, trip: true, place: t.place });
    }
  });
  return legs;
}

/** Whether the plan has a day that goes on this day trip (its town or stops name the place): then that day's own
 *  legs show the way there and back, and the stay's straight day-trip line would only be a second path. */
function planGoesTo(place: string) {
  const name = place.split(",")[0].trim().toLowerCase();
  return !!name && (state.itinerary?.days || []).some((d) =>
    [d.city, ...d.items.map((x) => x.place)].join(" ").toLowerCase().includes(name));
}

/** With one day picked: the stays that day touches, the leg travelled that day and the day trips it makes. */
function dayFilter() {
  const d = session.selectedDay != null ? state.itinerary?.days[session.selectedDay] : null;
  if (!d) return null;
  const stays = new Set<number>();
  state.stays.forEach((s, i) => { if (s.start && d.date >= s.start && d.date <= addDays(s.start, Number(s.nights) || 0)) stays.add(i); });
  const text = [d.city, ...d.items.map((x) => x.place)].join(" ").toLowerCase();
  return {
    stay: (i: number) => stays.has(i),
    leg: (l: StayLeg) => l.trip ? stays.has(l.i) && !!l.place && text.includes(l.place.split(",")[0].trim().toLowerCase()) : state.stays[l.i]?.start === d.date,
  };
}

/** The line drawn for the way into each stay (by the stay's place in the list), to light up from the plan. */
export const stayLines = new Map<number, L.Polyline>();

/** Draws the stays; returns their pin positions (for fitting the map). */
const STAY_LINES = "trip-planner-stay-lines";
/** The trip's lines between stays (and to day trips) are shown: on by default, switched in the Layers panel. */
export const stayLinesOn = () => localStorage.getItem(STAY_LINES) !== "0";
export function setStayLines(on: boolean) { localStorage.setItem(STAY_LINES, on ? "1" : "0"); }

export function drawStays(): LatLng[] {
  stayLines.clear();
  const accent = cssVar("--accent");
  const pts: LatLng[] = [];
  const only = dayFilter();
  state.stays.forEach((s, i) => {
    const loc = stayLoc(s); if (!loc) return;
    if (only && !only.stay(i)) return;
    pts.push([loc.lat, loc.lng]);
    const end = s.start ? addDays(s.start, s.nights) : "";
    L.marker([loc.lat, loc.lng], {
      icon: L.divIcon({ className: "", html: `<div class="stay-pin"><b>${i + 1}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }),
      zIndexOffset: 1000,
    }).bindTooltip(esc(s.city), { direction: "right", offset: [12, -16], permanent: session.selectedDay == null })
      .bindPopup(`<b>${esc(s.city)}</b><div class="pop-meta">${s.start ? `${fmtDate(s.start)} → ${fmtDate(end)} · ` : ""}${s.nights} night${s.nights == 1 ? "" : "s"}</div>${s.hotel ? `<div>${icon("bed")} ${esc(s.hotel)}</div>` : ""}<div><a href="${esc(stayMapsUrl(s))}" target="_blank" rel="noopener">${icon("pin")} Open in ${esc(mapsName())}</a></div>`)
      .on("click", () => focusStay(i))
      .addTo(layers.stays);
  });

  const driven: { mode: RouteMode; from: LatLng; to: LatLng }[] = [];
  const tripsBy = (state.stays.flatMap((s) => (s.dayTrips || []).map((t) => t.place)).filter(Boolean));
  // The lines between the stays and out to the day trips: a layer of their own (Layers panel), on unless switched off.
  for (const l of stayLinesOn() ? stayLegs() : []) {
    if (only && !only.leg(l)) continue;
    if (l.trip && l.place && planGoesTo(l.place)) continue;
    // A travel day that spells out its own journey draws it itself (leg by leg): no second line between the towns.
    if (!l.trip && stayLegOwned(l.i)) continue;
    const who = l.trip && l.place ? tripGroup(l.place) : { g: "", color: "" };
    const g = who.g, color = who.color || accent;
    // Day trips of different groups often share the tracks out of town: later ones drawn thinner on top.
    const wide = g ? Math.max(0, tripsBy.length - 1 - tripsBy.indexOf(l.place!)) * 3 : 0;
    // By road, by train along the tracks, by boat along its route, or by bike along cycle paths; flights are arcs.
    const how: RouteMode | null = l.mode === "car" || l.mode === "bus" ? "car" : l.mode === "train" ? "train" : l.mode === "ferry" ? "ferry" : l.mode === "bike" ? "bike" : null;
    const byRoad = !!how;
    // Through the travel day's stops on the way: one route made of the pieces between them.
    const pts: LatLng[] = [l.from, ...(l.via || []).map((v) => v.loc), l.to];
    const pieces = pts.slice(1).map((to, k) => ({ mode: how || "car", from: pts[k], to }));
    const got = byRoad ? pieces.map((p) => routes[routeKey(p.mode, p.from, p.to)]) : [];
    // By train or boat, from station to station (pier to pier): getting there and on to the sights are the day's own legs.
    const rail = (g: (typeof got)[number]) => (g?.rail ? g.c.slice(g.rail[0], g.rail[1] + 1) : g!.c);
    const r = byRoad && got.every(Boolean)
      ? { c: (how === "train" || how === "ferry") && got.length === 1 ? rail(got[0]) : got.flatMap((g) => g!.c), d: got.reduce((n, g) => n + g!.d, 0), t: got.reduce((n, g) => n + g!.t, 0) } : null;
    if (byRoad) driven.push(...pieces);
    const via = l.via?.length ? ` via ${l.via.map((v) => esc(v.name)).join(", ")}` : "";
    const tip = `${modeIcon(l.mode) || icon("arrowLeftRight")} ${esc(l.label)}${via}${l.mode ? ` · ${modeName(l.mode)}` : ""}${r ? ` · ${fmtDist(r.d)}, ${fmtDur(r.t)}` : ""}`;
    // A flight between stays: an arc, like a flight in the day's plan.
    const line = r ? r.c : l.mode === "flight" ? pts.slice(1).flatMap((p, k) => flightArc(pts[k], p).slice(k ? 1 : 0)) : pts;
    const vis = L.polyline(line, {
      // Day trips of different groups often share the tracks out of town: earlier groups wider underneath.
      color, weight: (r ? 3 : l.trip ? 1.5 : 2) + wide,
      opacity: l.trip && !g ? .55 : g ? .9 : .75, interactive: false,
      dashArray: r ? undefined : l.mode === "flight" ? "2 8" : "6 6",
    }).addTo(layers.stays);
    if (!l.trip) stayLines.set(l.i, vis);
    hoverBand(line, tip, vis).on("click", () => focusStay(l.i, !l.trip)).addTo(layers.stays);
    if (l.trip) L.circleMarker(l.to, { radius: 5, color, weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip(`${modeIcon(l.mode) || icon("pin")} Day trip: ${esc(l.place)}${g ? ` · ${esc(g)}` : ""}`, { direction: "top" }).addTo(layers.stays);
  }
  if (driven.length) requestRoutes(driven);
  return pts;
}
