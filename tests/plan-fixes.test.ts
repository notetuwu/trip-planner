// Smaller fixes around the plan: must-see markers out of the text, meals without a place, activities in another town,
// the chat's lookups and stop edits, bookings valid on several days, and re-plans that only carry their own days.
import { describe, expect, it } from "vitest";
import { ensureBookings, stripMustSee } from "../server/ai/output";
import { parseLookups, withoutLookups } from "../server/trip/chat-lookups";
import { parseChange, stopOps } from "../server/trip/companion";
import { hoursLines } from "../server/trip/hours-online";
import { partialScope, scopeTrip } from "../server/routes/itinerary";
import { activityTown, genericMeal } from "../web/src/geo/stop-text";

describe("must-see markers", () => {
  it("come out of names and descriptions", () => {
    expect(stripMustSee("Osaka Castle [MUST SEE]")).toBe("Osaka Castle");
    expect(stripMustSee("Kumamoto Castle [MUST SEE for 2 of 4 travelers - on the way]")).toBe("Kumamoto Castle");
    expect(stripMustSee("MUST SEE: The castle keep and its museum.")).toBe("The castle keep and its museum.");
    expect(stripMustSee("Schloss Neuschwanstein - MUST SEE")).toBe("Schloss Neuschwanstein");
  });
  it("stay in ordinary prose", () => {
    expect(stripMustSee("A must-see for castle fans.")).toBe("A must-see for castle fans.");
  });
});

describe("meals without a place", () => {
  it("search for restaurants in the town they name", () => {
    expect(genericMeal("Lunch in Vaduz")).toEqual({ what: "restaurants", where: "Vaduz" });
    expect(genericMeal("Dinner")).toEqual({ what: "restaurants", where: "" });
    expect(genericMeal("Coffee break in the old town")).toEqual({ what: "cafés", where: "old town" });
  });
  it("aren't named places", () => {
    expect(genericMeal("Lunch at Gasthof Adler")).toBeNull();
    expect(genericMeal("Kura Sushi")).toBeNull();
  });
});

describe("activities in a town", () => {
  it("give the town", () => {
    expect(activityTown("Kempten old town walk")).toBe("Kempten");
    expect(activityTown("Gaflei hamlet walk")).toBe("Gaflei");
    expect(activityTown("Walk through Lindau")).toBe("Lindau");
    expect(activityTown("Free time in Bregenz")).toBe("Bregenz");
  });
  it("leave places alone", () => {
    expect(activityTown("Kapellbrücke")).toBe("");
    expect(activityTown("Scheidegger Wasserfälle")).toBe("");
  });
});

describe("the chat's lookups", () => {
  it("are read from the reply and taken out of the text", () => {
    const reply = "LOOKUP: place | Gaflei, Liechtenstein\nLOOKUP: route | Vaduz | Gaflei\nLOOKUP: search | Aussichtsturm Gaflei hours";
    expect(parseLookups(reply)).toEqual([
      { kind: "place", args: ["Gaflei, Liechtenstein"] },
      { kind: "route", args: ["Vaduz", "Gaflei"] },
      { kind: "search", args: ["Aussichtsturm Gaflei hours"] },
    ]);
    expect(withoutLookups(`${reply}\nLet me check.`)).toBe("Let me check.");
  });
});

describe("stop edits from the chat", () => {
  it("are kept when well-formed", () => {
    const c = parseChange('Adding it.\nCHANGE: {"days": [], "request": "", "stops": [{"op": "add", "day": 5, "time": "14:30", "place": "Aussichtsturm Gaflei", "where": "Gaflei, Triesenberg, Liechtenstein", "cost": 0}]}', 19);
    expect(c?.stops).toEqual([{ op: "add", day: 5, place: "Aussichtsturm Gaflei", time: "14:30", description: "", where: "Gaflei, Triesenberg, Liechtenstein", cost: 0, kind: "sight" }]);
    expect(c?.request).toBe("");
  });
  it("drop days outside the plan and adds without a time", () => {
    expect(stopOps([{ op: "add", day: 30, time: "10:00", place: "X" }, { op: "add", day: 2, place: "Y" }, { op: "time", day: 2, place: "Café", time: "8:00" }], 19))
      .toEqual([{ op: "time", day: 2, place: "Café", time: "08:00" }]);
  });
});

describe("opening hours found online", () => {
  it("keep the lines about times and days", () => {
    const text = "Café Marigold\nhttps://example.com\nOpening hours: Mon-Fri 08:00-17:00, Sat 09:00-14:00\nThe best cake in town";
    expect(hoursLines(text)).toContain("08:00-17:00");
    expect(hoursLines(text)).not.toContain("best cake");
  });
});

describe("bookings valid on several days", () => {
  const plan = () => ({ days: [
    { date: "2027-09-09", items: [{ time: "10:00", place: "Museum" }] },
    { date: "2027-09-11", items: [{ time: "14:00", place: "Studio Retro Exhibition" }] },
  ] });
  it("stay on the day the planner picked within the range", () => {
    const it = plan();
    ensureBookings(it, [{ name: "Studio Retro Exhibition", date: "2027-09-09", until: "2027-09-13", lat: 34.69, lng: 135.5 }]);
    expect(it.days[0].items.map((x: any) => x.place)).toEqual(["Museum"]);
    expect(it.days[1].items[0]).toMatchObject({ lat: 34.69, lng: 135.5, fixed: true });
  });
  it("go on the first day when the planner left them out", () => {
    const it = plan();
    ensureBookings(it, [{ name: "Osaka Castle", date: "2027-09-09", until: "2027-09-30" }]);
    expect(it.days[0].items.map((x: any) => x.place)).toContain("Osaka Castle");
  });
});

describe("re-planning some days", () => {
  const trip: any = {
    stays: [
      { city: "Milan", start: "2027-09-14", nights: 3, lat: 45.46, lng: 9.19 },
      { city: "Luzern", start: "2027-09-17", nights: 2, lat: 47.05, lng: 8.31 },
    ],
    mustSee: ["Duomo di Milano", "Kapellbrücke"],
    redoDay: { day: 4, itinerary: { days: [0, 1, 2, 3, 4].map((i) => ({ date: `2027-09-${14 + i}`, items: [] })) } },
    nearby: [{ city: "Milan", sights: [], food: [] }, { city: "Luzern", sights: [], food: [] }],
    holidays: [{ date: "2027-09-14", name: "x" }, { date: "2027-09-18", name: "y" }],
    bookings: [{ name: "Last Supper", date: "2027-09-15" }],
  };
  it("only carries the places and must-sees of the stays those days touch", () => {
    const scope = partialScope(trip)!;
    expect([...scope.stays]).toEqual([1]);
    const places = scopeTrip(trip, [
      { title: "Duomo di Milano", lat: 45.464, lng: 9.19 },
      { title: "Kapellbrücke", lat: 47.0516, lng: 8.3075 },
    ] as any, scope);
    expect(places.map((p) => p.title)).toEqual(["Kapellbrücke"]);
    expect(trip.mustSee).toEqual(["Kapellbrücke"]);
    expect(trip.nearby.map((n: any) => n.city)).toEqual(["Luzern"]);
    expect(trip.holidays.map((h: any) => h.name)).toEqual(["y"]);
    expect(trip.bookings).toEqual([]);
  });
});

describe("the chat before there's a plan", () => {
  it("can add must-sees and day trips, but not change days", async () => {
    const { companionPrompt } = await import("../server/trip/companion");
    const p = companionPrompt({ model: "x", question: "add the Gaflei lookout as a must-see", days: 0 });
    expect(p).toContain('"addPlaces"');
    expect(p).toContain("generate the itinerary first");
    expect(parseChange('Added.\nCHANGE: {"days": [], "request": "", "trip": {"addPlaces": [{"name": "Aussichtsturm Gaflei", "where": "Triesenberg, Liechtenstein", "must": true}]}}', 0)?.trip)
      .toEqual({ addPlaces: [{ name: "Aussichtsturm Gaflei", where: "Triesenberg, Liechtenstein", must: true }] });
  });
});
