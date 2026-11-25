import { describe, expect, it } from "vitest";
import { kindFilters, kindQuery } from "../server/geo/area-search";

describe("searching an area for a kind of place", () => {
  it("knows everyday words, in the singular and plural", () => {
    expect(kindFilters("konbini")).toEqual(['["shop"="convenience"]']);
    expect(kindFilters("Convenience Stores")).toEqual(['["shop"="convenience"]']);
    expect(kindFilters("ATMs")).toContain('["amenity"="atm"]');
    expect(kindFilters("ramen")).toEqual(['["cuisine"~"ramen",i]']);
  });
  it("asks nothing for a name", () => {
    expect(kindFilters("mcdonalds")).toEqual([]);
    expect(kindQuery("mcdonalds", [34.6, 135.4, 34.7, 135.5])).toBe("");
  });
  it("asks for the kind in the box only", () => {
    expect(kindQuery("toilets", [34.6, 135.4, 34.7, 135.5])).toBe('[out:json][timeout:20];(nwr["amenity"="toilets"](34.60000,135.40000,34.70000,135.50000););out center tags 200;');
  });
});
