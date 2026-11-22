// The travelers' notes as requirements, bookings they already have, and step-by-step planning's place sorting.
import { describe, expect, it } from "vitest";
import { requestsSection } from "../server/ai/prompt-sections";
import { dropBookedAgain } from "../server/ai/output";
import { placesByStay } from "../server/ai/local-steps";

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
});
