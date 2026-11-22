// The data sections of the planning prompt: saved places, stays, holidays and nearby real places.
import { tune } from "../settings";
import type { Place } from "../../shared/types";
import { routeNote } from "../../shared/route";
import { addDays } from "../config";
import type { NearbyPlace } from "../trip/nearby";
import { driveNote } from "../trip/drives";
import { MODE_TEXT, type Trip } from "./types";

export function placeLines(trip: Trip, places: Place[]) {
  return places.map((p) => {
    const extra = [p.note, p.tags, p.comment, p.address].filter(Boolean).join(" | ");
    const who = trip.mustSeeWho?.[p.title];
    const route = routeNote(trip.mustSeeRoute?.[p.title]);
    const flag = trip.mustSee?.includes(p.title)
      ? ` [MUST SEE${who && who < trip.travelers ? ` for ${who} of ${trip.travelers} travelers` : ""}${route ? ` - ${route}` : ""}]`
      : trip.skip?.includes(p.title) ? " [SKIP]" : "";
    // Coordinates go in a separate tag (not the brackets) so models don't copy them into the place name.
    const at = typeof p.lat === "number" && typeof p.lng === "number" ? ` {location ${p.lat.toFixed(4)},${p.lng.toFixed(4)}}` : "";
    // Places picked on the map get their address so the model knows where they are, even if the name is just a shop.
    const picked = p.picked ? " {picked on the map}" : "";
    return `- ${p.title}${extra ? ` (${extra})` : ""}${at}${picked}${flag}`;
  }).join("\n");
}

/** Each stay with its travel days and full days spelled out, so day trips land on days without a transfer. */
export function stayLines(trip: Trip) {
  return trip.stays.map((s, i) => {
    const nights = Number(s.nights) || 0;
    const full = s.start ? Array.from({ length: Math.max(0, nights - 1) }, (_, k) => addDays(s.start, k + 1)) : [];
    const days = !s.start ? "" : nights === 0
      ? " (passing through, no overnight stay)"
      : `; travel days: ${s.start} (arrival) and ${addDays(s.start, nights)} (departure); full days: ${full.length ? full.join(", ") : "none"}`;
    const prev = trip.stays[i - 1];
    const drive = driveNote(trip, i);
    const travel = prev && s.travel && MODE_TEXT[s.travel] ? `\n   Getting here from ${prev.city}: ${MODE_TEXT[s.travel]} (chosen by the travelers)${drive ? `; ${drive}` : ""}` : "";
    const trips = (s.dayTrips || []).filter((t) => t.place)
      .map((t) => `\n   Planned day trip: ${t.place}${MODE_TEXT[t.mode] ? `, ${MODE_TEXT[t.mode]} there and back (chosen by the travelers)` : ""}, on one of the full days`).join("");
    return `${i + 1}. ${s.city}${s.country ? ` (${s.country})` : ""}: arrive ${s.start}, ${nights} night(s)${s.hotel ? `, staying at/near ${s.hotel}` : ""}${days}${travel}${trips}`;
  }).join("\n");
}

/** Whether the travelers fixed any transport mode (then the prompt adds rules for it). */
export const hasChosenModes = (trip: Trip) =>
  trip.stays.some((s, i) => (i > 0 && !!s.travel && !!MODE_TEXT[s.travel]) || (s.dayTrips || []).some((t) => t.place && MODE_TEXT[t.mode]));

export function holidayLines(trip: Trip) {
  return (trip.holidays || []).map((h) =>
    `- ${h.date} ${h.cc}: ${h.name}${h.localName && h.localName !== h.name ? ` (${h.localName})` : ""}${h.counties?.length ? ` - regional only: ${h.counties.join(", ")}` : " - nationwide"}`,
  ).join("\n");
}

const poiLine = (p: NearbyPlace) => `- ${p.name} (${[p.kind, ...p.extras, ...(p.hours ? [`hours ${p.hours}`] : [])].join("; ")}) {location ${p.lat},${p.lng}}`;

/** Real places near each stay. Compact: each town once, and only the best-ranked places, fewer the more towns there
 *  are (a few for places you only pass through), so a long trip doesn't fill a local model's context. */
export function nearbySection(trip: Trip, compact = false) {
  const lists = (trip.nearby || []).filter((n) => n.sights.length || n.food.length);
  const towns = compact ? [...new Map(lists.map((n) => [n.city.trim().toLowerCase(), n])).values()] : lists;
  const nights = (city: string) => trip.stays.filter((s) => s.city === city).reduce((n, s) => n + (Number(s.nights) || 0), 0);
  // Settings → Planning: fewer places (smaller, faster prompt) or more (more choice).
  const amount = tune().places, scale = amount === "fewer" ? 0.45 : amount === "more" ? 1.6 : 1;
  const perTown = Math.round(Math.max(8, Math.min(30, Math.floor(180 / Math.max(1, towns.length)))) * scale);
  return towns.map((n) => {
    const keep = !compact ? (amount === "fewer" ? 12 : 99) : nights(n.city) === 0 ? 4 : perTown;
    const sights = n.sights.slice(0, keep), food = n.food.slice(0, compact || amount === "fewer" ? Math.ceil(keep * 0.6) : 99);
    return `### ${n.city}\nSights:\n${sights.map(poiLine).join("\n") || "(none found)"}\nFood and drink:\n${food.map(poiLine).join("\n") || "(none found)"}`;
  }).join("\n\n");
}

/** One-line trip description for the research prompt. */
export function tripLine(trip: Trip) {
  return trip.stays.map((s, i) => `${s.city}${s.country ? ` (${s.country})` : ""} from ${s.start}, ${s.nights} night(s)`
    + `${i && s.travel && MODE_TEXT[s.travel] ? `, arriving ${MODE_TEXT[s.travel]}${driveNote(trip, i) ? ` (${driveNote(trip, i)})` : ""}` : ""}`
    + (s.dayTrips || []).filter((t) => t.place).map((t) => `, day trip to ${t.place}${MODE_TEXT[t.mode] ? ` ${MODE_TEXT[t.mode]}` : ""}`).join(""),
  ).join("; ");
}
