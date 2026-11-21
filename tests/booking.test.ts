import { describe, expect, it } from "vitest";
import { GETYOURGUIDE, KLOOK, bookableOnSite, bookingQuery, bookingSite, paidEntry, pickWebsite, ticketLinks, ticketQuery } from "../web/src/itinerary/booking-sites";

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
  it("links the place's own site, the platform for things to book ahead, else a ticket search", () => {
    const museum = item({ place: "Stadtmuseum", kind: "sight", cost: 12 });
    const castle = item({ kind: "sight", booking: "essential" });
    expect(ticketLinks(castle, ["Himeji"], KLOOK).map((l) => l.label)).toEqual(["Klook"]);
    expect(ticketLinks(castle, ["Himeji"], KLOOK, "https://example.org").map((l) => l.label)).toEqual(["Official site", "Klook"]);
    expect(ticketLinks(museum, ["Bamberg"], GETYOURGUIDE, "https://example.org/museum")).toMatchObject([{ url: "https://example.org/museum", label: "Tickets / info" }]);
    expect(ticketLinks(museum, ["Bamberg"], GETYOURGUIDE)[0].url).toBe("https://www.google.com/search?q=Stadtmuseum%20Bamberg%20tickets");
    expect(ticketLinks(item({ kind: "sight", cost: 0 }), ["Bamberg"], GETYOURGUIDE)).toEqual([]);
  });
  it("searches a ride's tickets by where it goes", () => {
    expect(ticketQuery("Luzern → Mount Pilatus (cog railway + cable car)")).toBe("Mount Pilatus cog railway + cable car");
    expect(ticketQuery("Uffizi Gallery")).toBe("Uffizi Gallery");
  });
  it("prefers a ticket page the model found over the homepage OpenStreetMap lists", () => {
    expect(pickWebsite("https://www.pilatus.ch", "https://www.pilatus.ch/bahnen/tickets")).toBe("https://www.pilatus.ch/bahnen/tickets");
    expect(pickWebsite("https://www.gletschergarten.ch/", "https://example.org/about")).toBe("https://www.gletschergarten.ch/");
    expect(pickWebsite(undefined, "https://example.org/about")).toBe("https://example.org/about");
  });
  it("adds the town unless the name has it", () => {
    expect(bookingQuery("Uffizi Gallery (book ahead)", "Florence")).toBe("Uffizi Gallery Florence");
    expect(bookingQuery("Nara Park", "Nara")).toBe("Nara Park");
    expect(bookingQuery("Schloss Lichtenstein", "Reutlingen (Schloss 1)")).toBe("Schloss Lichtenstein Reutlingen");
  });
});
