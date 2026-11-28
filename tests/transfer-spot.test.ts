// A transfer is on the map where it arrives, without anyone setting it by hand; only when that's known for sure.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Day, GeoHit, ItineraryItem } from "../shared/types";
import { state } from "../web/src/core/state";
import { arrivalSpot, itemLoc } from "../web/src/geo/item-loc";
import { genericDestination, vagueWhere } from "../web/src/geo/stop-text";
import { geo, geoKey } from "../web/src/geo/geocode";
// The page's modules look at where they were opened from.
vi.hoisted(() => { vi.stubGlobal("location", { protocol: "http:" }); });

const hit = (name: string, lat: number, lng: number, kind = "town"): GeoHit => ({ name, label: name, lat, lng, kind, cc: "se", country: "Sweden" });
const leg = (place: string, where?: string) => ({ time: "08:00", kind: "transfer", place, description: "", where }) as ItineraryItem;
const day = (...items: ItineraryItem[]) => ({ date: "2027-07-02", city: "Stockholm / Visby", title: "", estimatedCost: 0, items }) as unknown as Day;

describe("where a transfer arrives", () => {
  beforeEach(() => {
    for (const k of Object.keys(geo)) delete geo[k];
    state.stays = [];
    geo[geoKey("Stockholm")] = hit("Stockholm", 59.33, 18.07, "city");
    geo[geoKey("Visby")] = hit("Visby", 57.64, 18.3);
    geo[geoKey("Nynäshamn")] = hit("Nynäshamn", 58.9, 17.95);
  });

  it("is the destination looked up by name", () => {
    const x = leg("Stockholm → Nynäshamn (car)");
    expect(arrivalSpot(x, day(x))).toMatchObject({ lat: 58.9, lng: 17.95 });
  });
  it("is its \"where\" when that is found near the destination", () => {
    const x = leg("Nynäshamn → Visby (ferry)", "Visby hamnterminal");
    geo[geoKey("Visby hamnterminal", "se", [57.64, 18.3], true)] = hit("Visby hamnterminal", 57.633, 18.284, "ferry_terminal");
    expect(arrivalSpot(x, day(x))).toMatchObject({ lat: 57.633, lng: 18.284 });
  });
  it("is unknown for a hotel, or a result that is something else", () => {
    const toHotel = leg("Visby → Hotel (taxi)"), odd = leg("Visby → Gate 4 (walk)");
    geo[geoKey("Gate 4")] = hit("Porten", 57.6, 18.3, "restaurant");
    expect(arrivalSpot(toHotel, day(toHotel))).toBeNull();
    expect(arrivalSpot(odd, day(odd))).toBeNull();
  });
  it("is left off the map when far from everywhere the day goes", () => {
    const home = leg("Visby → Frankfurt (flight)");
    geo[geoKey("Frankfurt")] = hit("Frankfurt", 50.11, 8.68, "city");
    expect(arrivalSpot(home, day(home))).toBeNull();
  });
});

describe("a lookup that lands across the continent", () => {
  beforeEach(() => {
    for (const k of Object.keys(geo)) delete geo[k];
    state.stays = [{ city: "Stockholm", start: "2027-07-01", nights: 4, hotel: "" }] as never;
    geo[geoKey("Stockholm")] = hit("Stockholm", 59.33, 18.07, "city");
  });
  const palace = { time: "10:00", kind: "sight", place: "Rosendal Palace", description: "", where: "Stockholm, Sweden", lat: 59.329, lng: 18.107 } as ItineraryItem;
  const today = (...items: ItineraryItem[]) => ({ date: "2027-07-02", city: "Stockholm", title: "", estimatedCost: 0, items }) as unknown as Day;

  it("isn't where the day goes on: a transfer's destination found only far away", () => {
    // "Rosendal Palace" found only in another country, a "Port" in another one still.
    geo[geoKey("Rosendal Palace")] = hit("Rosendal Palace", 41.9, 12.45, "hospital");
    geo[geoKey("Port")] = hit("Port", 53.54, 9.98, "town");
    const ride = leg("Gamla stan → Rosendal Palace"), port = leg("Rosendal Palace → Port");
    for (const x of [ride, port]) {
      const loc = itemLoc(palace, today(x, palace), new Map());
      expect(loc!.lat).toBeGreaterThan(59);
    }
  });
  it("and a \"where\" that is only the town doesn't pin the stop on the town's middle", () => {
    geo[geoKey("Stockholm, Sweden", "se", [59.33, 18.07], true)] = hit("Stockholm", 59.33, 18.07, "city");
    geo[geoKey("Rosendal Palace, Stockholm", "se", [59.33, 18.07], true)] = hit("Rosendal Palace", 59.332, 18.12, "castle");
    expect(itemLoc(palace, today(palace), new Map())).toMatchObject({ lat: 59.332, lng: 18.12 });
  });
});

describe("stop texts that name no place", () => {
  it("knows a generic destination and a vague \"where\"", () => {
    expect(["Port", "Lunch", "the Hotel", "Parking"].every(genericDestination)).toBe(true);
    expect(["Port Vauban", "Visby"].some(genericDestination)).toBe(false);
    expect(["Stockholm, Sweden", "Near the museum", "Hotel"].every((w) => vagueWhere(w, ["Stockholm"]))).toBe(true);
    expect(["Rosendals Slott, Stockholm", "Stortorget 2"].some((w) => vagueWhere(w, ["Stockholm"]))).toBe(false);
  });
});
