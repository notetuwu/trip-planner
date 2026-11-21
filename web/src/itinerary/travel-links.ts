// Booking links for the trip's stays and transfers: hotels on Booking.com with the dates filled in, and Rome2Rio for
// getting between stays (it compares train, bus and flights and links on to Trainline, Omio and the operators).
import type { TravelMode } from "../../../shared/types";
import { addDays } from "../core/format";
import type { Stay } from "../core/state";

/** Booking.com search for a stay: the hotel (if named) or the town, with check-in/out and the group size. */
export function hotelUrl(s: Stay, travelers: number) {
  // "around the Garden Court Hotel" → "Garden Court Hotel": the search wants a name, not a note.
  const hotel = s.hotel.trim().replace(/^(around|near|close to|next to|by|somewhere near|in)\s+(the\s+)?/i, "");
  const q = new URLSearchParams({
    ss: hotel ? `${hotel}, ${s.city}` : s.city,
    checkin: s.start, checkout: addDays(s.start, Number(s.nights) || 1),
    group_adults: String(Math.max(1, travelers || 1)), no_rooms: "1", group_children: "0",
  });
  return `https://www.booking.com/searchresults.html?${q}`;
}

/** Rome2Rio's page for getting from one town to another (all ways to travel, with booking links). */
export const transportUrl = (from: string, to: string) =>
  `https://www.rome2rio.com/map/${encodeURIComponent(from.trim())}/${encodeURIComponent(to.trim())}`;

/** Travelers driving or cycling themselves don't book transport. */
export const bookableMode = (m: TravelMode | undefined) => m !== "car" && m !== "bike";
