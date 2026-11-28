// The sights a plan is given: landmarks and hidden gems both, in a list no longer than before.
import { describe, expect, it } from "vitest";
import { rankNearby, rankWished, wantsHere } from "../server/trip/nearby";

const place = (name: string, tags: Record<string, string>) => ({ lat: 48.2, lon: 16.37, tags: { name, ...tags } });
const languages = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`name:l${i}`, "x"]));

describe("ranking sights", () => {
  const small = Array.from({ length: 60 }, (_, i) => place(`Small museum ${i}`, { tourism: "museum", website: "https://example.org", opening_hours: "Mo 10:00-12:00" }));
  const museums = Array.from({ length: 40 }, (_, i) => place(`Museum ${i}`, { tourism: "museum", wikipedia: "de:x", website: "https://example.org", opening_hours: "Mo 10:00-12:00", ...languages(2) }));
  const church = place("Karlskirche", { amenity: "place_of_worship", tourism: "attraction", wikipedia: "de:Karlskirche", ...languages(30) });
  const { sights } = rankNearby([...small, ...museums, church], "");

  it("puts the most famous first, also one filed as something else", () => {
    expect(sights[0]).toMatchObject({ name: "Karlskirche", kind: "attraction" });
  });
  it("keeps the list's length, with every third a lesser-known place", () => {
    expect(sights).toHaveLength(30);
    expect(sights.filter((s) => s.name.startsWith("Small"))).toHaveLength(10);
    expect(sights[2].name).toMatch(/^Small/);
  });
  it("fills up with one kind when there's none of the other", () => {
    expect(rankNearby(small, "").sights).toHaveLength(30);
  });
});

describe("the travelers' preferences in the lists", () => {
  const veg = place("Grüner Garten", { amenity: "restaurant", "diet:vegetarian": "only", "diet:vegan": "yes", opening_hours: "Mo-Su 11:00-22:00" });
  const gf = place("Glutenfrei & Co", { amenity: "restaurant", "diet:gluten_free": "yes", "diet:vegan": "yes" });
  const steak = place("Steakhaus", { amenity: "restaurant", cuisine: "steak", website: "https://example.org", opening_hours: "Mo-Su 11:00-22:00" });
  const cafe = place("Kaffee", { amenity: "cafe" });

  it("puts restaurants that suit every diet first, then some of them, marked", () => {
    const { food } = rankNearby([steak, cafe, gf, veg], { diet: ["vegan", "gluten_free"], allergies: [], avoid: [], wants: [] });
    expect(food.map((f) => f.name)).toEqual(["Glutenfrei & Co", "Grüner Garten", "Steakhaus", "Kaffee"]);
    expect(food[0].extras).toEqual(["vegan options", "gluten-free options"]);
    expect(food[1].extras).toEqual(["vegan options"]);
    expect(food[2].extras).toEqual(["steak"]);
  });
  it("still reads a plain interests text for the diet", () => {
    expect(rankNearby([steak, veg], "we are vegetarian").food[0]).toMatchObject({ name: "Grüner Garten", extras: ["fully vegetarian"] });
  });
  it("famous sights only, or hidden gems first, as they like", () => {
    const small = Array.from({ length: 20 }, (_, i) => place(`Small ${i}`, { tourism: "museum" }));
    const big = Array.from({ length: 20 }, (_, i) => place(`Big ${i}`, { tourism: "museum", wikipedia: "de:x", ...languages(10) }));
    const prefs = (placeMix: "popular" | "hidden" | "mixed") => ({ diet: [], allergies: [], avoid: [], wants: [], placeMix });
    expect(rankNearby([...small, ...big], prefs("popular")).sights.slice(0, 20).every((s) => s.name.startsWith("Big"))).toBe(true);
    expect(rankNearby([...small, ...big], prefs("hidden")).sights.slice(0, 3).map((s) => s.name.split(" ")[0])).toEqual(["Small", "Small", "Big"]);
    expect(rankNearby([...small, ...big], prefs("mixed")).sights.slice(0, 3).map((s) => s.name.split(" ")[0])).toEqual(["Big", "Big", "Small"]);
    // Popular, but only a few are well known: the list fills up with the others.
    expect(rankNearby([...small, ...big.slice(0, 3)], prefs("popular")).sights).toHaveLength(23);
  });
  it("lists what they asked for by their words, the well-known first", () => {
    const want = (name: string, kind: string, tags: Record<string, string> = {}) => place(name, { ...tags, __want: kind });
    const els = [want("Faro Piccolo", "lighthouse", { man_made: "lighthouse" }), want("Faro di Genova", "lighthouse", { man_made: "lighthouse", wikipedia: "it:x", ...languages(12) }), want("Terme Vecchie", "thermal_bath", { amenity: "public_bath", opening_hours: "Mo-Su 09:00-21:00" })];
    const prefs = { diet: [], allergies: [], avoid: [], wants: [{ kind: "lighthouse" as const, what: "un faro" }, { kind: "thermal_bath" as const, what: "a spa day" }] };
    const wished = rankWished(els, prefs.wants, prefs);
    expect(wished.map((w) => [w.name, w.kind, w.for])).toEqual([["Faro di Genova", "lighthouse", "un faro"], ["Faro Piccolo", "lighthouse", "un faro"], ["Terme Vecchie", "thermal bath or spa", "a spa day"]]);
    expect(wished[2].hours).toBe("Mo-Su 09:00-21:00");
  });
  it("knows which stay a wish for a town belongs to", () => {
    expect(wantsHere("Budapest", "Budapest, Hungary")).toBe(true);
    expect(wantsHere("around Split", "Split, Croatia")).toBe(true);
    expect(wantsHere("Croatia", "Split, Croatia")).toBe(true); // the country: every stay there
    expect(wantsHere("Vienna", "Budapest, Hungary")).toBe(false);
  });
});
