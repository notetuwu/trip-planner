import { describe, expect, it } from "vitest";
import { GETYOURGUIDE, KLOOK, bookableOnSite, bookingQuery, bookingSite, paidEntry, ticketLink } from "../web/src/itinerary/booking-sites";

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

const item = (o: object) => ({ time: "10:00", place: "Himeji Castle", description: "", ...o });

describe("what gets which link", () => {
  it("sends things to book ahead to the platform", () => {
    expect(bookableOnSite(item({ booking: "recommended", kind: "sight" }))).toBe(true);
    expect(bookableOnSite(item({ booking: "optional", kind: "sight" }))).toBe(false);
    expect(bookableOnSite(item({ booking: "essential", kind: "meal" }))).toBe(false);
    expect(bookableOnSite(item({ booking: "essential", kind: "transfer" }))).toBe(false);
    expect(bookableOnSite(item({ booking: "optional", kind: "other", place: "Hotelstraße 1" }))).toBe(false);
  });
  it("treats anything with a price as paid entry, even untagged", () => {
    expect(paidEntry(item({ kind: "sight", cost: 12 }))).toBe(true);
    expect(paidEntry(item({ kind: "sight", cost: 0 }))).toBe(false);
    expect(paidEntry(item({ kind: "meal", cost: 30 }))).toBe(false);
    expect(paidEntry(item({ kind: "sight", cost: 40, place: "Venice" }), ["Padua", "Venice"])).toBe(false);
  });
  it("guesses for older plans without a kind", () => {
    expect(bookableOnSite(item({ booking: "essential" }))).toBe(true);
    expect(bookableOnSite(item({ booking: "essential", place: "Dinner at Kikunoi" }))).toBe(false);
    expect(bookableOnSite(item({ booking: "essential", place: "Milan → Rome (train)" }))).toBe(false);
  });
  it("picks platform, then the place's website, then a ticket search", () => {
    const museum = item({ place: "Stadtmuseum", kind: "sight", cost: 12 });
    expect(ticketLink(item({ kind: "sight", booking: "essential" }), ["Himeji"], KLOOK)?.label).toBe("Klook");
    expect(ticketLink(museum, ["Bamberg"], GETYOURGUIDE, "https://example.org/museum")).toMatchObject({ url: "https://example.org/museum", label: "Tickets / info" });
    expect(ticketLink(museum, ["Bamberg"], GETYOURGUIDE)?.url).toBe("https://www.google.com/search?q=Stadtmuseum%20Bamberg%20tickets");
    expect(ticketLink(item({ kind: "sight", cost: 0 }), ["Bamberg"], GETYOURGUIDE)).toBeNull();
  });
  it("adds the town unless the name has it", () => {
    expect(bookingQuery("Uffizi Gallery (book ahead)", "Florence")).toBe("Uffizi Gallery Florence");
    expect(bookingQuery("Nara Park", "Nara")).toBe("Nara Park");
    expect(bookingQuery("Schloss Lichtenstein", "Reutlingen (Schloss 1)")).toBe("Schloss Lichtenstein Reutlingen");
  });
});
