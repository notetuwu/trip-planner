// A transfer is on the map where it arrives, without anyone setting it by hand; only when that's known for sure.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Day, GeoHit, ItineraryItem } from "../shared/types";
import { state } from "../web/src/core/state";
import { arrivalSpot } from "../web/src/geo/item-loc";
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
