import { describe, expect, it } from "vitest";
import { GETYOURGUIDE, KLOOK, bookableOnSite, bookingQuery, bookingSite } from "../web/src/itinerary/booking-sites";

describe("booking site", () => {
  it("uses Klook for trips entirely in East/Southeast Asia", () => {
    expect(bookingSite(["JP"])).toBe(KLOOK);
    expect(bookingSite(["jp", "KR"])).toBe(KLOOK);
  });
  it("uses one site (GetYourGuide) for Europe and mixed trips", () => {
    expect(bookingSite(["DE", "AT", "IT"])).toBe(GETYOURGUIDE);
    expect(bookingSite(["JP", "DE"])).toBe(GETYOURGUIDE);
    expect(bookingSite([])).toBe(GETYOURGUIDE);
  });
  it("builds search links", () => {
    expect(KLOOK.search("Himeji Castle")).toBe("https://www.klook.com/search/result/?query=Himeji%20Castle");
    expect(GETYOURGUIDE.search("Uffizi Florence")).toBe("https://www.getyourguide.com/s/?q=Uffizi%20Florence");
  });
});

describe("what can be booked there", () => {
  const item = (o: object) => ({ time: "10:00", place: "Himeji Castle", description: "", ...o });
  it("links tickets and tours, not meals or transfers", () => {
    expect(bookableOnSite(item({ booking: "recommended", kind: "sight" }))).toBe(true);
    expect(bookableOnSite(item({ booking: "essential", kind: "meal" }))).toBe(false);
    expect(bookableOnSite(item({ booking: "essential", kind: "transfer" }))).toBe(false);
    expect(bookableOnSite(item({ kind: "sight" }))).toBe(false);
  });
  it("guesses for older plans without a kind", () => {
    expect(bookableOnSite(item({ booking: "essential" }))).toBe(true);
    expect(bookableOnSite(item({ booking: "essential", place: "Dinner at Kikunoi" }))).toBe(false);
    expect(bookableOnSite(item({ booking: "essential", place: "Milan → Rome (train)" }))).toBe(false);
  });
  it("adds the town unless the name has it", () => {
    expect(bookingQuery("Uffizi Gallery (book ahead)", "Florence")).toBe("Uffizi Gallery Florence");
    expect(bookingQuery("Nara Park", "Nara")).toBe("Nara Park");
  });
});
