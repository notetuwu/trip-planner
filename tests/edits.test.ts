// Who changed which part of a trip, joining those stamps, and what changed in words.
import { describe, expect, it } from "vitest";
import { changedParts, dayKey, describePart, joinEdits, joinLogs, logChanges, mergeTrip, partLabel, partOfPath, partsOf, setPart, stamp } from "../shared/edits";

const day = (date: string, city: string, places: string[]) => ({ date, city, title: city, estimatedCost: 0, items: places.map((place, i) => ({ time: `${9 + i}:00`, place, description: "" })) });
const trip = (extra: object = {}) => ({
  stays: [{ city: "Kyoto", start: "2027-04-01", nights: 2, hotel: "" }], travelers: 2, notes: "", marks: {},
  itinerary: { summary: "s", totalEstimatedCost: 0, days: [day("2027-04-01", "Kyoto", ["Kinkaku-ji"]), day("2027-04-02", "Kyoto", ["Fushimi Inari"])] },
  photoSpots: { a: { lat: 1, lng: 2 } },
  ...extra,
});

describe("the parts of a trip", () => {
  it("names days by date (by place when the date is missing or shared), and each photo by itself", () => {
    expect(Object.keys(partsOf(trip())).sort()).toEqual(["day:2027-04-01", "day:2027-04-02", "details", "photo:a", "places", "plan", "stays"]);
    expect(dayKey([{ date: "x" }, { date: "x" }, { date: "" }], 0)).toBe("day:#0");
    expect(dayKey([{ date: "x" }, { date: "y" }], 1)).toBe("day:y");
  });

  it("tells which parts changed, and leaves out each person's own settings", () => {
    const t = trip(), u = structuredClone(t) as any;
    u.itinerary.days[1].items[0].time = "07:00"; u.photoSpots.b = { skip: true }; u.chatMode = "auto"; u.model = "opus";
    expect(changedParts(t, u).sort()).toEqual(["day:2027-04-02", "photo:b"]);
  });
});

describe("stamps", () => {
  it("stamps what changed, keeps the rest, and stamps nothing on a first save", () => {
    const t = { ...trip(), edits: { stays: { by: "Lena", at: 1 } } }, u = { ...structuredClone(t), notes: "cash" };
    expect(stamp(t, u, { by: "Me", id: "me1" }, 50)).toEqual({ stays: { by: "Lena", at: 1 }, details: { by: "Me", id: "me1", at: 50 } });
    expect(stamp(null, trip(), { by: "Me" })).toBeUndefined();
  });

  it("drops a day's stamp once the day is gone from the plan", () => {
    const t = { ...trip(), edits: { "day:2027-04-02": { by: "Lena", at: 1 } } }, u = structuredClone(t) as any;
    u.itinerary.days.pop();
    expect(stamp(t, u, { by: "Me" }, 9) ?? {}).not.toHaveProperty(["day:2027-04-02"]);
  });

  it("joins newest-wins, ignoring anything malformed", () => {
    expect(joinEdits({ a: { by: "A", at: 1 }, b: { by: "B", at: 9 } }, { a: { by: "C", at: 5 }, b: { by: "D", at: 2 }, c: "x" as any })).toEqual({ a: { by: "C", at: 5 }, b: { by: "B", at: 9 } });
  });

  it("two people changing different days join without a clash, with both stamps", () => {
    const base = trip(), a = structuredClone(base) as any, b = structuredClone(base) as any;
    a.itinerary.days[0].items[0].place = "Ginkaku-ji"; a.edits = { "day:2027-04-01": { by: "Me", at: 5 } };
    b.itinerary.days[1].items[0].place = "Tōfuku-ji"; b.edits = { "day:2027-04-02": { by: "Lena", at: 6 } };
    const m = mergeTrip(base, a, b);
    expect(m.clashes).toEqual([]);
    expect((m.value as any).itinerary.days.map((d: any) => d.items[0].place)).toEqual(["Ginkaku-ji", "Tōfuku-ji"]);
    expect(Object.keys((m.value as any).edits).sort()).toEqual(["day:2027-04-01", "day:2027-04-02"]);
  });

  it("puts a clash in the part it belongs to", () => {
    const t = trip();
    expect(partOfPath("itinerary.days[1].items[0].time", t)).toBe("day:2027-04-02");
    expect(partOfPath("photoSpots.a.lat", t)).toBe("photo:a");
    expect(partOfPath("notes", t)).toBe("details");
    expect(partOfPath("marks.Temple", t)).toBe("places");
    expect(partOfPath("itinerary.summary", t)).toBe("plan");
  });
});

describe("undoing a part", () => {
  it("puts a day, a photo or a group of fields back", () => {
    const t = trip() as any, was = partsOf(t), u = structuredClone(t) as any;
    u.itinerary.days[0].items = []; u.photoSpots.a = { lat: 5, lng: 5 }; u.travelers = 4; u.photoSpots.z = { skip: true };
    for (const k of ["day:2027-04-01", "photo:a", "details", "photo:z"]) expect(setPart(u, k, was[k])).toBe(true);
    expect(changedParts(t, u)).toEqual([]);
    expect(setPart(u, "day:2030-01-01", was["day:2027-04-01"])).toBe(false);
  });
});

describe("in words", () => {
  it("says what changed in a day, the stays, the photos and the bookings", () => {
    const a = day("d", "Kyoto", ["Kinkaku-ji", "Nishiki Market"]), b = day("d", "Kyoto", ["Kinkaku-ji", "Gion"]);
    b.items[0].time = "08:00";
    expect(describePart("day:d", a, b)).toBe("added Gion; removed Nishiki Market; 1 time changed");
    expect(describePart("stays", [{ city: "Kyoto, Japan", nights: 2 }], [{ city: "Kyoto, Japan", nights: 3 }, { city: "Osaka" }])).toBe("added Osaka; changed Kyoto");
    expect(describePart("photo:a", undefined, { lat: 1, lng: 1 })).toBe("placed");
    expect(describePart("photo:a", { lat: 1, lng: 1 }, { lat: 2, lng: 1 })).toBe("moved");
    expect(describePart("photo:a", { lat: 1, lng: 1 }, undefined)).toBe("reset");
    expect(describePart("bookings", [{ name: "Ghibli Museum" }], [{ name: "Ghibli Museum" }, { name: "teamLab" }])).toBe("added teamLab");
    expect(describePart("details", { travelers: 2, notes: "" }, { travelers: 3, notes: "x" })).toBe("travelers 2 → 3, notes for the plan");
    expect(describePart("places", { marks: {} }, { marks: { Temple: "must" } })).toBe("starred Temple");
  });

  it("names the parts", () => {
    expect(partLabel("day:2027-04-02", trip())).toBe("Day 2 · Kyoto");
    expect(partLabel("stays")).toBe("Stays");
    expect(partLabel("photo:x")).toBe("Photo on the map");
  });
});

describe("the history of changes", () => {
  it("records each change with who and when, and a photo's spots before and after", () => {
    const t = trip() as any, u = structuredClone(t);
    u.photoSpots.a = { lat: 3, lng: 4 }; u.photoSpots.b = { lat: 1, lng: 1 };
    const log = logChanges(t, u, { by: "Lena", id: "l" }, 100);
    expect(log).toEqual([
      { key: "photo:a", by: "Lena", id: "l", at: 100, what: "moved", from: { lat: 1, lng: 2 }, to: { lat: 3, lng: 4 } },
      { key: "photo:b", by: "Lena", id: "l", at: 100, what: "placed", to: { lat: 1, lng: 1 } },
    ]);
  });

  it("makes one change of the same person changing the same thing again soon (and none when it ends where it started)", () => {
    const t = trip() as any, u = structuredClone(t), v = structuredClone(t);
    u.photoSpots.a = { lat: 3, lng: 4 };
    v.photoSpots.a = { lat: 5, lng: 6 };
    const one = logChanges(t, u, { by: "Me" }, 100), two = logChanges({ ...u, log: one }, { ...v, log: one }, { by: "Me" }, 200);
    expect(two).toEqual([{ key: "photo:a", by: "Me", at: 200, what: "moved", from: { lat: 1, lng: 2 }, to: { lat: 5, lng: 6 } }]);
    expect(logChanges({ ...v, log: two }, { ...t, log: two }, { by: "Me" }, 300)).toEqual([]);
    // Someone else, or much later: a change of its own.
    expect(logChanges({ ...u, log: one }, { ...v, log: one }, { by: "Lena" }, 200)).toHaveLength(2);
    expect(logChanges({ ...u, log: one }, { ...v, log: one }, { by: "Me" }, 100 + 11 * 60_000)).toHaveLength(2);
  });

  it("a new plan is one change, not one per day", () => {
    const t = trip() as any, u = structuredClone(t);
    u.itinerary.days = [1, 2, 3, 4, 5, 6].map((i) => day(`2027-05-0${i}`, "Osaka", ["Castle"]));
    expect(logChanges(t, u, { by: "Me" }, 1).map((c) => c.key)).toEqual(["plan"]);
  });

  it("both sides' histories are kept when their changes are joined", () => {
    const base = trip(), a = { ...structuredClone(base), notes: "x", log: [{ key: "details", by: "Me", at: 1, what: "notes" }] };
    const b = { ...structuredClone(base), ideas: "y", log: [{ key: "ideas", by: "Lena", at: 2, what: "edited" }] };
    const m = mergeTrip(base, a, b);
    expect(m.clashes).toEqual([]);
    expect((m.value as any).log.map((c: any) => c.by)).toEqual(["Me", "Lena"]);
    expect(joinLogs(a.log, a.log, b.log)).toHaveLength(2);
  });
});
