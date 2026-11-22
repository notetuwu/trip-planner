// Place lookups run in two lanes side by side: stops and towns start with Nominatim, saved places with Photon, and
// a miss moves to the other lane instead of holding up its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let geocodeBatch: typeof import("../server/geo/geocode").geocodeBatch;
const calls: string[] = [];

beforeAll(async () => {
  process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-geo-"));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url)), q = u.searchParams.get("q") || "";
    const service = u.hostname.startsWith("nominatim") ? "N" : "P";
    calls.push(`${service}:${q}`);
    const json = (o: unknown) => new Response(JSON.stringify(o));
    if (service === "N") return json(q === "Kyoto" || q === "Kinkaku-ji" ? [{ lat: "35", lon: "135.7", name: q, display_name: `${q}, Japan`, address: { country: "Japan", country_code: "jp" }, type: "city", category: "place" }] : []);
    return json({ features: q.startsWith("Ramen") ? [{ geometry: { coordinates: [135.75, 35.01] }, properties: { name: q, countrycode: "JP", country: "Japan" } }] : [] });
  }));
  ({ geocodeBatch } = await import("../server/geo/geocode"));
});
afterAll(() => vi.unstubAllGlobals());

const until = async (ok: () => boolean, ms = 8000) => {
  for (const t0 = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() - t0 > ms) throw new Error("timed out");
};

describe("place lookups in two lanes", () => {
  it("starts each where it's answered best, moves misses over, and keeps the answers", async () => {
    const qs = [
      { q: "Kyoto", cc: "jp", first: true },                       // a stay: Nominatim
      { q: "Kinkaku-ji", cc: "jp", first: true, stop: true },      // a stop: Nominatim
      { q: "Ramen Ichiran", cc: "jp" },                            // a saved place: Photon
      { q: "Nowhere Café", cc: "jp" },                             // not found anywhere: Photon, then Nominatim
    ];
    expect(geocodeBatch(qs).pending).toBe(4);
    await until(() => geocodeBatch(qs).pending === 0);
    const res = geocodeBatch(qs).results as Record<string, { name: string } | null>;
    expect(res["kyoto|jp"]?.name).toBe("Kyoto");
    expect(res["ramen ichiran|jp"]?.name).toBe("Ramen Ichiran");
    expect(res["nowhere café|jp"]).toBeNull();
    // The saved place went to Photon straight away, without waiting behind the Nominatim lookups.
    expect(calls.indexOf("P:Ramen Ichiran")).toBeLessThan(calls.indexOf("N:Kinkaku-ji"));
    expect(calls).toContain("N:Nowhere Café");
    expect(calls.filter((c) => c.endsWith(":Kyoto"))).toEqual(["N:Kyoto"]);
  }, 15000);
});
