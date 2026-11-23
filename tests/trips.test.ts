// Your trips: when a trip is and how that reads, search / filter / order, grouping by year, the route sketch, and the
// cards the server makes from saved trips.
import { describe, expect, it } from "vitest";
import type { TripCard } from "../shared/types";
import { groupTrips, pickTrips, previewSvg, whenLabel, whenOf } from "../web/src/saves/trip-cards";
import { tripCard } from "../server/routes/trips";

const card = (name: string, start: string, end: string, extra: Partial<TripCard> = {}): TripCard => ({
  name, savedAt: "2026-01-01T00:00:00Z", title: "", cities: ["Padua"], start, end, nights: 3, travelers: 1, days: 0, cost: 0, currency: "EUR",
  countries: [{ cc: "it", country: "Italy" }], route: [[45.4, 11.88]], dots: [], bookings: 0, mustSees: 0, ...extra,
});
const TODAY = "2026-11-23";

describe("Your trips", () => {
  it("knows when a trip is, in words", () => {
    expect(whenLabel(card("a", "2026-11-24", "2026-11-30"), TODAY)).toBe("Tomorrow");
    expect(whenLabel(card("a", "2026-12-14", "2026-12-20"), TODAY)).toBe("In 3 weeks");
    expect(whenLabel(card("a", "2027-09-06", "2027-09-27"), TODAY)).toBe("In 9 months");
    expect(whenLabel(card("a", "2026-11-20", "2026-11-30"), TODAY)).toBe("Day 4 of 11");
    expect(whenLabel(card("a", "2024-06-01", "2024-06-10"), TODAY)).toBe("2 years ago");
    expect(whenLabel(card("a", "", ""), TODAY)).toBe("No dates yet");
    expect(whenOf(card("a", "2026-11-23", "2026-11-23"), TODAY)).toBe("now");
  });
  it("searches towns and countries, filters and orders (undated last by date)", () => {
    const cards = [card("Old", "2024-06-01", "2024-06-05", { countries: [{ cc: "at", country: "Austria" }] }), card("Next", "2027-01-01", "2027-01-09", { nights: 8 }), card("Idea", "", "")];
    expect(pickTrips(cards, { query: "", filter: "all", sort: "date-desc", today: TODAY }).map((c) => c.name)).toEqual(["Next", "Old", "Idea"]);
    expect(pickTrips(cards, { query: "", filter: "all", sort: "date-asc", today: TODAY }).map((c) => c.name)).toEqual(["Old", "Next", "Idea"]);
    expect(pickTrips(cards, { query: "austria", filter: "all", sort: "name", today: TODAY }).map((c) => c.name)).toEqual(["Old"]);
    expect(pickTrips(cards, { query: "", filter: "upcoming", sort: "name", today: TODAY }).map((c) => c.name)).toEqual(["Next"]);
    expect(pickTrips(cards, { query: "", filter: "all", sort: "length", today: TODAY })[0].name).toBe("Next");
  });
  it("groups by trip date: coming up, now, each past year, no dates; other orders aren't grouped", () => {
    const cards = [card("A", "2027-01-01", "2027-01-02"), card("B", "2026-11-20", "2026-11-30"), card("C", "2025-03-01", "2025-03-02"), card("D", "2023-03-01", "2023-03-02"), card("E", "", "")];
    expect(groupTrips(cards, "date-desc", TODAY).map((g) => g.label)).toEqual(["Coming up", "Happening now", "2025", "2023", "No dates yet"]);
    expect(groupTrips(cards, "name", TODAY)).toHaveLength(1);
  });
  it("draws the route through the stays, or a globe when nothing is located", () => {
    const svg = previewSvg(card("a", "", "", { route: [[45.4, 11.88], [45.46, 9.19], [46.5, 11.35]] }));
    expect(svg).toContain("<polyline");
    expect(svg.match(/class="pv-stay/g)).toHaveLength(3);
    expect(previewSvg(card("a", "", "", { route: [] }))).toContain("pv-globe");
  });
  it("the server's card: dates, nights, plan, countries and the route from the lookups", () => {
    const where = new Map([["padua, italy", { lat: 45.4, lng: 11.88, cc: "it", country: "Italy" }], ["lucerne", { lat: 47.05, lng: 8.31, cc: "ch", country: "Switzerland" }]]);
    const c = tripCard("Trip", "2026-01-01T00:00:00Z", {
      travelers: 2, currency: "EUR", marks: { X: "must", Y: "skip" },
      stays: [{ city: "Padua, Italy", start: "2027-09-14", nights: 2 }, { city: "Lucerne", start: "2027-09-16", nights: 3 }, { city: "Nowhere", start: "2027-09-19", nights: 1 }],
      itinerary: { destination: "Alps", days: [{ items: [{ lat: 45.41, lng: 11.87 }, { place: "x" }] }], totalEstimatedCost: 900 },
    }, where);
    expect(c).toMatchObject({ start: "2027-09-14", end: "2027-09-20", nights: 6, travelers: 2, days: 1, title: "Alps", cost: 900, mustSees: 1 });
    expect(c.cities).toEqual(["Padua", "Lucerne", "Nowhere"]);
    expect(c.countries.map((x) => x.cc)).toEqual(["it", "ch"]);
    expect(c.route).toEqual([[45.4, 11.88], [47.05, 8.31]]); // "Nowhere" was never found: left out
    expect(c.dots).toEqual([[45.41, 11.87]]);
  });
});
