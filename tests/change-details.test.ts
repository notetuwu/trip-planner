// What exactly a change did, line by line (the Changes window).
import { describe, expect, it } from "vitest";
import { changeLines, valueText, wordDiff } from "../shared/change-details";

const stop = (time: string, place: string, extra: object = {}) => ({ time, place, description: "", ...extra });
const day = (date: string, items: object[], extra: object = {}) => ({ date, city: "Kyoto", title: "Kyoto", estimatedCost: 0, items, ...extra });

describe("a change, line by line", () => {
  it("says a field's old and new value in the travelers' words", () => {
    expect(changeLines("details", { travelers: 1, dailyBudget: 100, getAround: "", interests: "food" }, { travelers: 2, dailyBudget: 80, getAround: "transit", interests: "food" })).toEqual([
      { what: "travelers", before: "1", after: "2" }, { what: "budget", before: "100", after: "80" }, { what: "getting around", after: "transit" },
    ]);
  });

  it("lists a day's stops added, removed, retimed and reordered, and its other fields", () => {
    const before = day("2027-04-02", [stop("09:00", "Kinkaku-ji"), stop("12:00", "Lunch"), stop("14:00", "Gion", { cost: 10 })]);
    const after = day("2027-04-02", [stop("09:00", "Gion", { cost: 12 }), stop("10:30", "Kinkaku-ji"), stop("16:00", "Fushimi Inari")], { notes: "Start early" });
    expect(changeLines("day:2027-04-02", before, after)).toEqual([
      { what: "added", after: "16:00 Fushimi Inari" },
      { what: "removed", before: "12:00 Lunch" },
      { what: "Gion: time", before: "14:00", after: "09:00" }, { what: "Gion: cost", before: "10", after: "12" },
      { what: "Kinkaku-ji: time", before: "09:00", after: "10:30" },
      { what: "order", before: "Kinkaku-ji → Gion", after: "Gion → Kinkaku-ji" },
      { what: "notes", after: "Start early" },
    ]);
  });

  it("names stays, bookings and expenses by what they're called", () => {
    expect(changeLines("stays", [{ city: "Kyoto", nights: 2, hotel: "" }], [{ city: "Kyoto", nights: 3, hotel: "Inn" }, { city: "Nara", nights: 1 }])).toEqual([
      { what: "added", after: "Nara (1 night)" }, { what: "Kyoto: nights", before: "2", after: "3" }, { what: "Kyoto: hotel", after: "Inn" },
    ]);
    expect(changeLines("expenses", { a: { what: "Ramen", amount: 12 } }, { a: { what: "Ramen", amount: 14 }, b: { what: "Taxi", amount: 20 } })).toEqual([
      { what: "added", after: "Taxi" }, { what: "Ramen: amount", before: "12", after: "14" },
    ]);
    expect(changeLines("ideas", "onsen", "onsen, karaoke")).toEqual([{ what: "", before: "onsen", after: "onsen, karaoke" }]);
    expect(changeLines("places", { marks: { Gion: "must" } }, { marks: { Gion: "skip", Nara: "must" } })).toEqual([
      { what: "must-sees: Gion", before: "must", after: "skip" }, { what: "must-sees: Nara", after: "must" },
    ]);
  });

  it("gives a line per day for a change to many days at once, and none for a photo", () => {
    const was = { days: [day("2027-04-01", [stop("09:00", "A")]), day("2027-04-02", [stop("09:00", "B")])] };
    const now = { days: [day("2027-04-01", [stop("09:00", "A"), stop("11:00", "C")]), day("2027-04-02", [stop("09:00", "B")]), day("2027-04-03", [stop("10:00", "D")])] };
    expect(changeLines("plan", was, now, true)).toEqual([{ what: "day 1 · 2027-04-01", after: "added C" }, { what: "day 3 · 2027-04-03", after: "new: D" }]);
    expect(changeLines("photo:x", { lat: 1 }, { lat: 2 })).toEqual([]);
    expect(valueText({ fuel: "petrol", per100: 6 })).toBe("fuel: petrol, per100: 6");
  });

  it("marks the words that went and came in a longer text", () => {
    expect(wordDiff("temples and good food in the evening", "temples, gardens and good food in the evening")).toEqual([
      { op: -1, text: "temples" }, { op: 1, text: "temples," }, { op: 0, text: " " }, { op: 1, text: "gardens " }, { op: 0, text: "and good food in the evening" },
    ]);
    expect(wordDiff("one two three", "completely different words here")).toBeNull();
  });
});
