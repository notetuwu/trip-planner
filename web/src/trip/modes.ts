// Transport between stays and on day trips, and helpers for reading itinerary stops.
import type { ItineraryItem, TravelMode } from "../../../shared/types";
import { state } from "../core/state";
import { type IconName, icon } from "../core/icons";
import { modeOf } from "./mode-of";
export { modeOf };

/** "" lets the planner choose. */
export const TRAVEL_MODES: [TravelMode, string][] = [["", "Planner decides"], ["car", "Car"], ["train", "Train"], ["bus", "Bus"], ["flight", "Flight"], ["ferry", "Ferry"], ["bike", "Bike"]];
const MODE_ICONS: Partial<Record<TravelMode, IconName>> = { car: "car", train: "train", bus: "bus", flight: "plane", ferry: "ship", bike: "bike" };
const label = (m: TravelMode | undefined) => (m ? TRAVEL_MODES.find(([k]) => k === m)?.[1] || "" : "");
export const modeName = (m?: TravelMode) => label(m).toLowerCase();
/** The mode's icon as SVG markup, or "" when the planner decides. */
export const modeIcon = (m?: TravelMode) => (m && MODE_ICONS[m] ? icon(MODE_ICONS[m]!) : "");
/** The menu; with `planned`, "Planner decides" says what the current plan picked ("Planner decides (train)"). */
export const modeOptions = (sel?: TravelMode, planned?: TravelMode) =>
  TRAVEL_MODES.map(([k, text]) => `<option value="${k}"${(sel || "") === k ? " selected" : ""}>${!k && planned ? `${text} (${modeName(planned)})` : text}</option>`).join("");

/** "Salzburg → Hallstatt" style transfers. */
export const ARROW = /\s*(?:→|->|⇒|–>)\s*/;
/** A stop's name without bracketed details. */
export const cleanStop = (s: string) => String(s).replace(/\s*\([^)]*\)/g, "").trim();
/** [from, to] of a transfer, or null for a normal stop. */
export const transferEnds = (x: ItineraryItem) => {
  const ends = cleanStop(x.place).split(ARROW).filter(Boolean);
  return ends.length === 2 ? (ends as [string, string]) : null;
};

const normCity = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(",")[0].trim();
const sameCity = (x: string, y: string) => { const a = normCity(x), b = normCity(y); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };

/** The mode the travelers picked for a transfer ("Padua → Milan") or a day trip ("Milan → Rome", "Rome → Milan"). */
export function chosenMode(x: ItineraryItem): TravelMode {
  const ends = transferEnds(x);
  if (!ends) return "";
  const [a, b] = ends;
  for (let i = 1; i < state.stays.length; i++) {
    const s = state.stays[i];
    if (s.travel && sameCity(a, state.stays[i - 1].city) && sameCity(b, s.city)) return s.travel;
  }
  for (const s of state.stays) for (const t of s.dayTrips || []) {
    if (t.mode && t.place && ((sameCity(a, s.city) && sameCity(b, t.place)) || (sameCity(a, t.place) && sameCity(b, s.city)))) return t.mode;
  }
  return "";
}

/** The mode the current plan uses between two places, either way round ("" without a plan or a matching transfer).
 *  Used where the travelers left it to the planner, so the map can draw the real route. */
export function plannedMode(from: string, to: string): TravelMode {
  for (const d of state.itinerary?.days || []) for (const x of d.items) {
    const ends = transferEnds(x);
    if (!ends) continue;
    const [a, b] = ends;
    if ((sameCity(a, from) && sameCity(b, to)) || (sameCity(a, to) && sameCity(b, from))) {
      const m = modeOf(x);
      if (m) return m;
    }
  }
  return "";
}

// The --track-N colour that looks like each day colour (by index in DAY_COLORS): blue, amber, purple, teal.
const CLASH: Record<number, number> = { 1: 3, 2: 0, 3: 2, 4: 1, 5: 3, 7: 0, 8: 1, 9: 3 };
/** A day's split groups' colours (0-3, the --track-N colours), in order of appearance, skipping the one that looks
 *  like the day's own colour; the same in the plan and on the map. */
export function dayGroupColors(items: ItineraryItem[], dayIndex: number): Record<string, number> {
  const free = [0, 1, 2, 3].filter((t) => t !== CLASH[dayIndex % 10]);
  const out: Record<string, number> = {};
  for (const x of items) { const g = splitGroup(x); if (g && !(g in out)) out[g] = free[Object.keys(out).length % free.length]; }
  return out;
}

/** While the group is split, each group's stops one after another (A's, then B's) instead of mixed by time, so
 *  each group's numbers run in order (2, 3, 4 and 5, 6, 7). True if anything moved. */
export function orderSplitRuns(days: { items: ItineraryItem[] }[]): boolean {
  let moved = false;
  for (const d of days) {
    const out: ItineraryItem[] = [];
    let run: ItineraryItem[] = [];
    const flush = () => {
      const order = [...new Set(run.map(splitGroup))];
      const sorted = [...run].sort((a, b) => order.indexOf(splitGroup(a)) - order.indexOf(splitGroup(b)));
      if (sorted.some((x, i) => x !== run[i])) moved = true;
      out.push(...sorted); run = [];
    };
    for (const x of d.items) { if (splitGroup(x)) run.push(x); else { flush(); out.push(x); } }
    flush();
    if (moved) d.items = out;
  }
  return moved;
}

/** A stop's subgroup while the travelers are split up, or "" when everyone is together. Some models label shared
 *  stops "All" or give a group with everyone in it; that isn't a split. */
export const splitGroup = (x: ItineraryItem) => {
  const g = String(x.group || "").trim();
  if (!g || /^(all|everyone|everybody|together|whole group|both|group)$/i.test(g)) return "";
  if (x.people && x.people >= (state.travelers || 1) && (state.travelers || 1) > 1) return "";
  return g;
};
