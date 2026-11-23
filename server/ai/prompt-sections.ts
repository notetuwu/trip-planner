// The data sections of the planning prompt: saved places, stays, holidays and nearby real places.
import { tune } from "../settings";
import type { Booking, Place } from "../../shared/types";
import { routeNote } from "../../shared/route";
import { addDays } from "../config";
import type { NearbyPlace } from "../trip/nearby";
import { driveNote } from "../trip/drives";
import { MODE_TEXT, type Trip } from "./types";

/** A date with its weekday ("2026-11-02 (Mon)"), so models don't have to work it out (they often get it wrong). */
export const withDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return isNaN(+d) ? iso : `${iso} (${d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })})`;
};

/** The travelers' own words ("Anything else"), as requirements: fixed dates, bookings they already have, things to
 *  skip, and questions to answer. Models tended to skim them as one line among the constraints. */
export function requestsSection(trip: { notes?: string }) {
  const notes = String(trip.notes || "").trim();
  if (!notes) return "";
  return `## The travelers' own requests (follow these exactly)
${notes}

How to treat them:
- Anything tied to a date or time ("on the 14th", "Monday when we land", "between the 9th and 13th") goes exactly then.
- Things they say they have already booked go on the booked date and time; don't give them "booking" or "bookAhead" (write "already booked" in the description instead).
- Things they say they skip or don't want never appear, not even as a generic stop (e.g. no hotel breakfast if they skip it).
- Questions they ask are answered in the planning notes or the tips.`;
}

/** Real train connections from a timetable service, so transfers use the actual lines (not a detour from memory). */
export function trainsSection(trip: { trains?: string[] }) {
  if (!trip.trains?.length) return "";
  return `## Train connections (looked up in a timetable service: trust these over your own idea of the rail network)
${trip.trains.join("\n")}

Use these routes for the transfers they cover: the same stations, lines and kinds of train, and about this long (the trains in the names are examples; similar ones run through the day). Don't route via other cities when a direct connection is listed.`;
}

/** What's already booked: fixed points the plan has to work around. */
export function bookingsSection(trip: { bookings?: Booking[]; currency?: string }) {
  const list = (trip.bookings || []).filter((b) => b.name && b.date).sort((a, b) => (a.date + (a.from || "")).localeCompare(b.date + (b.from || "")));
  if (!list.length) return "";
  const time = (b: Booking) => b.from ? (b.to ? `${b.from}-${b.to}` : `from ${b.from}`) : "";
  const day = (b: Booking) => b.until && b.until > b.date
    ? `any one day from ${withDay(b.date)} to ${withDay(b.until)} (a ticket valid for those days: you pick the best day)${time(b) ? `, ${time(b)}` : ""}`
    : `${withDay(b.date)}, ${time(b) || "any time that day"}`;
  const where = (b: Booking) => [b.where, typeof b.lat === "number" && typeof b.lng === "number" ? `{location ${b.lat.toFixed(4)},${b.lng.toFixed(4)}}` : ""].filter(Boolean).join(" ");
  const ranged = list.some((b) => b.until && b.until > b.date);
  return `## Already booked (fixed: plan everything else around these)
${list.map((b) => `- ${day(b)}: ${b.name}${where(b) ? ` at ${where(b)}` : ""}${b.cost != null ? `; cost ${b.cost} ${trip.currency || ""}${b.countCost ? "" : " (already paid: put 0 as its cost)"}` : ""}`).join("\n")}

Each booking is a stop on exactly its day${list.some((b) => b.from) ? " and time" : ""} (where only the day is given, pick a sensible time), under its name, with "already booked" in the description and no "booking"/"bookAhead".${ranged ? " A ticket valid for several days goes on exactly one of them: the day that fits best (near the other stops that day, open then, not a travel day if possible)." : ""} Where a booking has a location, that's where it is (use it for "lat"/"lng"). Plan the rest of that day around it: getting there in time, things nearby before and after, meals that fit. Nothing else may overlap it.`;
}

/** "only 2 of the 4 travelers go" for a day trip part of the group takes. */
const tripWho = (trip: Trip, people?: number) =>
  people && people < (Number(trip.travelers) || 1) ? `only ${people} of the ${trip.travelers} travelers go` : "";

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
      : `; travel days: ${withDay(s.start)} arrival and ${withDay(addDays(s.start, nights))} departure; full days: ${full.length ? full.map(withDay).join(", ") : "none"}`;
    const prev = trip.stays[i - 1];
    const drive = driveNote(trip, i);
    const travel = prev && s.travel && MODE_TEXT[s.travel] ? `\n   Getting here from ${prev.city}: ${MODE_TEXT[s.travel]} (chosen by the travelers)${drive ? `; ${drive}` : ""}` : "";
    const trips = (s.dayTrips || []).filter((t) => t.place)
      .map((t) => `\n   Planned day trip: ${t.place}${MODE_TEXT[t.mode] ? `, ${MODE_TEXT[t.mode]} there and back (chosen by the travelers)` : ""}, on one of the full days${tripWho(trip, t.people) ? `; ${tripWho(trip, t.people)} (a split day, see the rules below)` : ""}`).join("");
    const light = trip.daylight?.[i] ? `\n   Daylight: ${trip.daylight[i]}` : "";
    return `${i + 1}. ${s.city}${s.country ? ` (${s.country})` : ""}: arrive ${withDay(s.start)}, ${nights} night(s)${s.hotel ? `, staying at/near ${s.hotel}` : ""}${days}${light}${travel}${trips}`;
  }).join("\n");
}

/** Whether the travelers fixed any transport mode (then the prompt adds rules for it). */
export const hasChosenModes = (trip: Trip) =>
  trip.stays.some((s, i) => (i > 0 && !!s.travel && !!MODE_TEXT[s.travel]) || (s.dayTrips || []).some((t) => t.place && MODE_TEXT[t.mode]));

export function holidayLines(trip: Trip) {
  return (trip.holidays || []).map((h) =>
    `- ${withDay(h.date)} ${h.cc}: ${h.name}${h.localName && h.localName !== h.name ? ` (${h.localName})` : ""}${h.counties?.length ? ` - regional only: ${h.counties.join(", ")}` : " - nationwide"}`,
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
  return trip.stays.map((s, i) => `${s.city}${s.country ? ` (${s.country})` : ""} from ${withDay(s.start)}, ${s.nights} night(s)`
    + `${i && s.travel && MODE_TEXT[s.travel] ? `, arriving ${MODE_TEXT[s.travel]}${driveNote(trip, i) ? ` (${driveNote(trip, i)})` : ""}` : ""}`
    + (s.dayTrips || []).filter((t) => t.place).map((t) => `, day trip to ${t.place}${MODE_TEXT[t.mode] ? ` ${MODE_TEXT[t.mode]}` : ""}${tripWho(trip, t.people) ? ` (${tripWho(trip, t.people)})` : ""}`).join(""),
  ).join("; ");
}
