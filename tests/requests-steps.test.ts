// The travelers' notes as requirements, bookings they already have, and step-by-step planning's place sorting.
import { describe, expect, it } from "vitest";
import { requestsSection } from "../server/ai/prompt-sections";
import { dropBookedAgain } from "../server/ai/output";
import { outlineProblems, placesByStay } from "../server/ai/local-steps";

const NOTES = "add mcdonalds on monday when we land. also we wont have a car. we also skip hotel breakfast and we have a teamlabs borderless booking on the 14th alongside a booking for the kojima expo";

describe("the travelers' requests", () => {
  it("get their own section with rules for dates, bookings and skips", () => {
    const s = requestsSection({ notes: NOTES });
    expect(s).toContain("## The travelers' own requests (follow these exactly)");
    expect(s).toContain("kojima expo");
    expect(s).toMatch(/already booked/);
    expect(requestsSection({ notes: "" })).toBe("");
  });
  it("stops they already booked lose book-ahead", () => {
    const it2: any = { days: [{ items: [
      { place: "teamLab Borderless: MORI Building DIGITAL ART MUSEUM", booking: "essential", bookAhead: "2 weeks before" },
      { place: "Kojima Productions Exhibition", booking: "essential" },
      { place: "Tokyo Skytree", booking: "recommended" },
    ] }] };
    dropBookedAgain(it2, NOTES);
    expect(it2.days[0].items.map((x: any) => x.booking || "")).toEqual(["", "", "recommended"]);
  });
});

describe("step by step: places by stay", () => {
  it("gives each stay the places near it or its day trips, must-sees first", () => {
    const trip: any = {
      travelers: 2, mustSee: ["Senko-ji"], skip: ["Skipped Bar"],
      stays: [
        { city: "Osaka", start: "2026-11-02", nights: 6, lat: 34.69, lng: 135.50, dayTrips: [{ place: "Onomichi" }] },
        { city: "Tokyo", start: "2026-11-08", nights: 5, lat: 35.68, lng: 139.76 },
      ],
    };
    const { perStay, unplaced } = placesByStay(trip, [
      { title: "Dotonbori", lat: 34.669, lng: 135.501 },
      { title: "Senko-ji", lat: 34.412, lng: 133.202 },
      { title: "Shibuya Crossing", lat: 35.659, lng: 139.700 },
      { title: "Skipped Bar", lat: 34.67, lng: 135.50 },
      { title: "Onomichi Ramen", address: "Onomichi, Hiroshima" },
      { title: "Cat Alley", lat: 34.41, lng: 133.20, address: "Onomichi, Hiroshima" },
      { title: "Far Away Cafe", lat: 26.2, lng: 127.7 },
      { title: "Somewhere unknown" },
    ] as any);
    expect(perStay[0].map((p) => p.title)).toEqual(["Senko-ji", "Dotonbori", "Onomichi Ramen", "Cat Alley"]);
    expect(perStay[1].map((p) => p.title)).toEqual(["Shibuya Crossing"]);
    expect(unplaced.map((p) => p.title)).toEqual(["Somewhere unknown"]);
  });
  it("matches places by town name when a stay has no location", () => {
    const trip: any = { travelers: 2, mustSee: [], skip: [], stays: [
      { city: "Osaka", start: "2026-11-02", nights: 3, lat: 34.69, lng: 135.50 },
      { city: "Hakone", start: "2026-11-05", nights: 2 },
    ] };
    const { perStay } = placesByStay(trip, [
      { title: "Hakone Open-Air Museum", lat: 35.24, lng: 139.05, address: "Ninotaira, Hakone" },
      { title: "Dotonbori", lat: 34.669, lng: 135.501 },
    ] as any);
    expect(perStay[0].map((p) => p.title)).toEqual(["Dotonbori"]);
    expect(perStay[1].map((p) => p.title)).toEqual(["Hakone Open-Air Museum"]);
  });
});

describe("step by step: checking the outline", () => {
  it("finds missing must-sees and day trips, unpaired split day trips and repeats", () => {
    const trip: any = { travelers: 4, mustSee: ["Arashiyama Bamboo Forest", "Pokemon Center Osaka DX"], stays: [{ city: "Osaka", start: "2026-11-02", nights: 6,
      dayTrips: [{ place: "Kyoto" }, { place: "Onomichi", people: 2 }, { place: "Hiroshima", people: 2 }] }] };
    const outline: any = { days: [
      { date: "2026-11-02", city: "Osaka", places: ["Dotonbori"] },
      { date: "2026-11-03", city: "Osaka", places: ["Pokemon Center Osaka DX (Daimaru)", "Hakone Open-Air Museum"] },
      { date: "2026-11-04", city: "Osaka / Hiroshima", groups: [{ group: "Group A", where: "Hiroshima", places: ["Atomic Bomb Dome"] }] },
      { date: "2026-11-05", city: "Osaka / Onomichi", groups: [{ group: "Group A", where: "Onomichi", places: ["Senko-ji"] }] },
      { date: "2026-11-06", city: "Osaka", places: ["Hakone Open-Air Museum"] },
    ] };
    const p = outlineProblems(trip, outline);
    expect(p.join(" ")).toContain("Arashiyama Bamboo Forest");
    expect(p.join(" ")).not.toContain("Pokemon");
    expect(p.find((x) => x.includes("no day"))).toContain("Kyoto");
    expect(p.find((x) => x.includes("same day"))).toContain("Onomichi");
    expect(p.find((x) => x.includes("more than one day"))).toContain("hakone open air museum");
    outline.days[3].date = "2026-11-04"; outline.days[2].groups.push(outline.days[3].groups[0]); outline.days.splice(3, 1);
    expect(outlineProblems(trip, outline).some((x) => x.includes("same day"))).toBe(false);
  });
});


import { tidyStops } from "../server/ai/output";

describe("tidying a day's stops", () => {
  it("drops stations and the hotel as stops, and repeats, keeping check-in and real sights", () => {
    const d: any = { items: [
      { time: "08:00", place: "Osaka Station (Shinkansen)", kind: "transfer", cost: 0, transport: "Midosuji Line, 10 min" },
      { time: "09:00", place: "Osaka → Himeji (JR Special Rapid)", kind: "transfer", cost: 30 },
      { time: "10:00", place: "Himeji Castle", kind: "sight", cost: 20, transport: "Walk 15 min" },
      { time: "11:00", place: "Himeji Castle", kind: "sight", cost: 0 },
      { time: "16:00", place: "Check-in & rest – Garden Court Hotel", kind: "other" },
      { time: "21:00", place: "Maple Tokyo Riverside Hotel", kind: "other" },
    ] };
    tidyStops(d);
    expect(d.items.map((x: any) => x.place)).toEqual(["Osaka → Himeji (JR Special Rapid)", "Himeji Castle", "Check-in & rest – Garden Court Hotel"]);
    expect(d.items[0].transport).toBe("Midosuji Line, 10 min");
  });
});

describe("step by step: two day trips in one day", () => {
  it("is flagged unless the group splits up", () => {
    const trip: any = { travelers: 4, mustSee: [], stays: [{ city: "Osaka", start: "2026-11-02", nights: 6, dayTrips: [{ place: "Kyoto" }, { place: "Nara" }] }] };
    const outline: any = { days: [
      { date: "2026-11-03", city: "Kyoto / Nara", places: ["Arashiyama", "Nara Park"] },
      { date: "2026-11-04", city: "Osaka", places: ["Dotonbori"] },
    ] };
    expect(outlineProblems(trip, outline).some((p) => p.includes("two day trips"))).toBe(true);
  });
});

import { buildPrompt } from "../server/ai/prompt";

describe("what they want to see", () => {
  it("goes into the prompt with the highlights-and-hidden-gems rule", () => {
    const trip: any = { travelers: 2, dailyBudget: 80, currency: "EUR", pace: "balanced (3-5 stops per day)", interests: "food", wishes: "big must-sees plus hidden gems",
      notes: "", stays: [{ city: "Kyoto", start: "2026-11-02", nights: 3, hotel: "" }], research: false };
    const p = buildPrompt(trip, []);
    expect(p).toContain("- What they want to see: big must-sees plus hidden gems");
    expect(p).toMatch(/essential highlights[^\n]*lesser-known spots[^\n]*weighted the way they describe/);
    expect(buildPrompt({ ...trip, wishes: "" }, [])).not.toContain("What they want to see:");
  });
});
