// The sights a plan is given: landmarks and hidden gems both, in a list no longer than before.
import { describe, expect, it } from "vitest";
import { rankNearby } from "../server/trip/nearby";

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
