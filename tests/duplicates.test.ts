import { describe, expect, it } from "vitest";
import { findDuplicates } from "../web/src/itinerary/duplicates";

const day = (date: string, places: (string | { place: string; kind?: string; description?: string })[]) => ({
  date, city: "Verona", title: "", estimatedCost: 0,
  items: places.map((p) => (typeof p === "string" ? { time: "10:00", place: p, description: "" } : { time: "10:00", description: "", ...p })),
});
const plan = (...days: ReturnType<typeof day>[]) => ({ summary: "", totalEstimatedCost: 0, days }) as any;

describe("findDuplicates", () => {
  it("finds a place inside a combined stop on another day", () => {
    const it2 = plan(
      day("2027-09-14", ["Arena di Verona", "Loggia di Frà Giocondo & Case Mazzanti"]),
      day("2027-09-15", ["Lake Garda"]),
      day("2027-09-17", ["Case Mazzanti", "Castelvecchio"]),
    );
    expect(findDuplicates(it2)).toEqual([{ first: [0, 1], again: [2, 0], key: "case mazzanti" }]);
  });

  it("ignores accents and case, but not one-word names inside longer ones", () => {
    const it2 = plan(day("2027-09-14", ["Loggia di Fra Giocondo", "Arena"]), day("2027-09-17", ["loggia di frà giocondo", "Arena di Verona"]));
    expect(findDuplicates(it2)).toEqual([{ first: [0, 0], again: [1, 0], key: "loggia di fra giocondo" }]);
  });

  it("lets hotels, stations, bookings and plain meals repeat, but not a named restaurant", () => {
    const it2 = plan(
      day("2027-09-14", ["Hotel Milano", "Verona Porta Nuova station", { place: "Opera at the Arena", description: "Already booked" }, { place: "Lunch", kind: "meal" }, { place: "Osteria Sottoriva", kind: "meal" }]),
      day("2027-09-17", ["Hotel Milano", "Verona Porta Nuova station", { place: "Opera at the Arena", description: "Already booked" }, { place: "Lunch", kind: "meal" }, { place: "Osteria Sottoriva", kind: "meal" }]),
    );
    expect(findDuplicates(it2)).toEqual([{ first: [0, 4], again: [1, 4], key: "osteria sottoriva" }]);
  });

  it("names the shared part, and skips repeats marked fine", () => {
    const it2 = plan(day("2027-09-14", ["Loggia di Frà Giocondo & Case Mazzanti", "Lake Lucerne walk"]), day("2027-09-17", ["Case Mazzanti", "Lake Lucerne Walk"]));
    expect(findDuplicates(it2).map((d) => d.key)).toEqual(["case mazzanti", "lake lucerne walk"]);
    expect(findDuplicates(it2, new Set(["lake lucerne walk"]))).toEqual([{ first: [0, 0], again: [1, 0], key: "case mazzanti" }]);
  });

  it("only compares days of the same town's stays", () => {
    const stays = [{ city: "Copenhagen", start: "2027-07-01", nights: 2 }, { city: "Gdansk", start: "2027-07-03", nights: 2 }, { city: "Copenhagen, Denmark", start: "2027-07-05", nights: 1 }];
    const it2 = plan(
      day("2027-07-01", ["Waterfront walk"]),
      // The travel day: before the ride still Copenhagen, after it Gdansk.
      day("2027-07-03", ["Round Tower", { place: "Copenhagen → Gdansk", kind: "transfer" }, "Old Crane"]),
      day("2027-07-04", ["Waterfront walk", "Round Tower"]),
      day("2027-07-05", [{ place: "Gdansk → Copenhagen", kind: "transfer" }, "Waterfront walk"]),
    );
    expect(findDuplicates(it2, new Set(), stays)).toEqual([{ first: [0, 0], again: [3, 1], key: "waterfront walk" }]);
  });

  it("leaves the same place twice on one day to the day's own tidy-up", () => {
    expect(findDuplicates(plan(day("2027-09-14", ["Castelvecchio", "Castelvecchio"])))).toEqual([]);
  });
});
