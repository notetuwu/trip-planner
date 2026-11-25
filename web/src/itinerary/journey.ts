// The journey between two stays, as a card in the travel day: the rides the day already has (metro, Shinkansen, the taxi
// up to the hotel) grouped under "Osaka → Hakone", from the hotel they leave to the one they arrive at. A travel day
// without its rides gets a suggested journey instead, from the stays' own travel mode and the route found for it, which
// "Use this" writes into the day as stops.
import type { Day, ItineraryItem, Ride, TravelMode } from "../../../shared/types";
import { esc } from "../core/dom";
import { money } from "../core/format";
import { icon } from "../core/icons";
import { state } from "../core/state";
import { stayLoc } from "../geo/locate";
import { routeKey, routes } from "../map/routes";
import { rideIcon } from "../map/legs";
import { isTransfer, journeyOf } from "../map/travel-day";
import { chosenMode, modeIcon, modeName, modeOf, plannedMode } from "../trip/modes";
import { type JourneyRun, insertAt, journeySpan, namesRide } from "./journey-model";

type Stay = (typeof state.stays)[number];

/** The hotel's name for the card ("Garden Court Hotel"), or the town when there's none (or only a long address). */
function hotelOf(s: Stay | undefined) {
  const h = String(s?.hotel || "").trim().replace(/^(around|near|close to)\s+(the\s+)?/i, "");
  const name = h && h.length <= 48 && !/\d{3}-?\d{4}|^\d/.test(h) ? h.charAt(0).toUpperCase() + h.slice(1) : "";
  return name || s?.city.split(",")[0] || "";
}

const town = (s: Stay | undefined) => s?.city.split(",")[0].trim() || "";

/** How a ride goes: what they picked, its own words, or (a ride named only by its name) from that. */
function rideMode(x: ItineraryItem): TravelMode {
  return chosenMode(x) || modeOf({ ...x, kind: isTransfer(x) || namesRide(x) ? "transfer" : x.kind });
}

/** The travel day's journey, worked out once per render: its runs, where each starts, and which stops are in one. */
export interface DayJourney { from?: Stay; to?: Stay; runs: JourneyRun[]; start: Map<number, number>; inRun: Set<number> }
export function dayJourney(d: Day): DayJourney | null {
  const j = journeyOf(d);
  if (!j) return null;
  return {
    from: state.stays[j.arrive - 1], to: state.stays[j.arrive], runs: j.runs,
    start: new Map(j.runs.map((r, k) => [r.items[0], k])), inRun: new Set(j.runs.flatMap((r) => r.items)),
  };
}

/** One run of the journey as a card around its stops (`rows`, the usual stop rows): the first says where they leave
 *  from, with the whole journey's modes, times and cost; the last where they arrive. */
export function journeyCard(d: Day, j: DayJourney, k: number, rows: string, cur: string) {
  const first = k === 0, last = k === j.runs.length - 1;
  const all = j.runs.flatMap((r) => r.items).map((i) => d.items[i]);
  const modes = [...new Set(all.map(rideMode).filter(Boolean))];
  const main = modes.find((m) => ["flight", "train", "ferry"].includes(m)) || modes[0];
  const span = journeySpan(d.items, j.runs);
  const meta = first ? [modes.length ? `by ${modes.map(modeName).join(" + ")}` : "", span.from ? `${span.from} → ${span.to}` : "", span.cost ? money(span.cost, cur) : ""].filter(Boolean).join(" · ") : "";
  return `<li class="journey">
    <div class="journey-head"><span class="journey-icon">${modeIcon(main) || icon("route")}</span><b>${esc(town(j.from))} → ${esc(town(j.to))}</b>${first ? "" : `<span class="hint">continued</span>`}${meta ? `<span class="journey-meta">${esc(meta)}</span>` : ""}</div>
    ${first ? `<div class="journey-end">${icon("bed")} Leave ${esc(hotelOf(j.from))}</div>` : ""}
    <ul class="items">${rows}</ul>
    ${last ? `<div class="journey-end">${icon("bed")} Arrive at ${esc(hotelOf(j.to))}</div>` : ""}
  </li>`;
}

/** The way between the two stays the map found for their travel mode (straight there, with its rides), if any. */
function stayRoute(j: DayJourney) {
  const a = stayLoc(j.from!), b = stayLoc(j.to!);
  const mode: TravelMode = j.to?.travel || plannedMode(j.from?.city || "", j.to?.city || "");
  const how = mode === "car" || mode === "bus" ? "car" : mode === "train" ? "train" : mode === "ferry" ? "ferry" : mode === "bike" ? "bike" : null;
  const r = a && b && how ? routes[routeKey(how, [a.lat, a.lng], [b.lat, b.lng])] : undefined;
  return { mode, route: r || null };
}

/** What kind of ride it is, in a word ("Shinkansen", "Train", "Bus"). */
function rideWord(r: Ride) {
  const m = r.mode.toUpperCase();
  return m === "HIGHSPEED_RAIL" ? "High-speed train" : /SUBWAY|METRO/.test(m) ? "Metro" : /BUS|COACH/.test(m) ? "Bus" : /FERRY/.test(m) ? "Boat"
    : /TRAM/.test(m) ? "Tram" : /AIR/.test(m) ? "Flight" : /GONDOLA|AERIAL|FUNICULAR/.test(m) ? "Cable car" : "Train";
}
const fmtMin = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`; };

/** A travel day with none of its rides as stops: the journey as the stays have it, offered to add to the day. */
export function suggestedJourney(di: number, j: DayJourney) {
  if (!j.from || !j.to || !stayLoc(j.from) || !stayLoc(j.to)) return "";
  const { mode, route } = stayRoute(j);
  const rides = route?.rides || [];
  const rows = rides.length
    ? rides.map((r) => `<li><span class="journey-ride-icon">${icon(rideIcon(r))}</span>${r.dep ? `<time>${esc(r.dep)}</time>` : ""}<span>${esc([rideWord(r), r.line].filter(Boolean).join(" "))}: ${esc(r.on.n || "?")} → ${esc(r.off.n || "?")}</span></li>`).join("")
    : route ? `<li><span class="journey-ride-icon">${modeIcon(mode) || icon("route")}</span><span>${esc(modeName(mode) || "There")}: ${(route.d / 1000).toFixed(0)} km, about ${fmtMin(route.t)}</span></li>` : "";
  const how = mode ? `by ${modeName(mode)}` : "the planner decides how";
  return `<li class="journey suggested">
    <div class="journey-head"><span class="journey-icon">${modeIcon(mode) || icon("route")}</span><b>${esc(town(j.from))} → ${esc(town(j.to))}</b><span class="journey-meta">${esc([how, route ? fmtMin(route.t) : ""].filter(Boolean).join(" · "))}</span></div>
    <div class="journey-end">${icon("bed")} Leave ${esc(hotelOf(j.from))}</div>
    ${rows ? `<ul class="journey-rides">${rows}</ul>` : `<p class="hint journey-none">${mode ? "The way there is still being looked up (it shows on the map)." : "Pick how they travel between the stays in the setup to see the way here."}</p>`}
    <div class="journey-end">${icon("bed")} Arrive at ${esc(hotelOf(j.to))}</div>
    <div class="journey-act"><span class="hint">Not in the day's plan yet: only on the map.</span>${route ? `<button type="button" class="btn" data-journey-use="${di}" title="Add these rides to the day as its stops, with their times">${icon("plus")} Use this</button>` : ""}</div>
  </li>`;
}

/** "Use this": the suggested journey's rides written into the day as its stops (each ending where it gets off, so the
 *  map draws it ride by ride); a drive is one stop. True if anything was added. */
export function useSuggestedJourney(di: number): boolean {
  const d = state.itinerary?.days[di], j = d && dayJourney(d);
  if (!d || !j?.from || !j.to || j.runs.length) return false;
  const { mode, route } = stayRoute(j);
  if (!route) return false;
  const from = town(j.from), to = town(j.to);
  const stops: ItineraryItem[] = route.rides?.length
    ? route.rides.map((r) => ({
      time: r.dep || "", place: `${[rideWord(r), r.line].filter(Boolean).join(" ")} ${r.on.n || from} → ${r.off.n || to}`,
      description: r.to ? `Towards ${r.to}.` : "", kind: "transfer" as const, transport: `By ${rideWord(r).toLowerCase()}`,
      pinned: true, lat: r.off.lat, lng: r.off.lng, fromList: false,
    }))
    : [{ time: "", place: `${mode === "car" ? "Drive" : `By ${modeName(mode) || "road"}`} ${from} → ${to}`, description: `About ${(route.d / 1000).toFixed(0)} km, ${fmtMin(route.t)}.`, kind: "transfer" as const, transport: mode === "car" ? "By car" : `By ${modeName(mode)}`, fromList: false }];
  for (const s of stops) d.items.splice(insertAt(d.items, s.time), 0, s);
  return true;
}
