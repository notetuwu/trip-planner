// With a Geoapify key, saved places are shared between Geoapify and Photon, and a miss moves on to the next service.
// Without a key Geoapify is never asked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let geo: typeof import("../server/geo/geocode");
const calls: string[] = [];

beforeAll(async () => {
  process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-geoapify-"));
  process.env.GEOAPIFY_API_KEY = "test-key";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url));
    const json = (o: unknown) => new Response(JSON.stringify(o));
    if (u.hostname.startsWith("api.geoapify")) {
      const q = u.searchParams.get("text") || "";
      calls.push(`G:${q}`);
      expect(u.searchParams.get("apiKey")).toBe("test-key");
      return json({ features: q.startsWith("Shop") ? [{ geometry: { coordinates: [139.7, 35.6] }, properties: { name: q, formatted: `${q}, Tokyo, Japan`, lat: 35.6, lon: 139.7, country: "Japan", country_code: "jp", result_type: "amenity", rank: { confidence: 0.9 } } }] : [] });
    }
    const q = u.searchParams.get("q") || "";
    if (u.hostname.startsWith("photon")) {
      calls.push(`P:${q}`);
      return json({ features: q.startsWith("Temple") ? [{ geometry: { coordinates: [135.7, 35] }, properties: { name: q, countrycode: "JP", country: "Japan" } }] : [] });
    }
    calls.push(`N:${q}`);
    return json([]);
  }));
  geo = await import("../server/geo/geocode");
});
afterAll(() => { vi.unstubAllGlobals(); delete process.env.GEOAPIFY_API_KEY; });

const until = async (ok: () => boolean, ms = 15000) => {
  for (const t0 = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() - t0 > ms) throw new Error("timed out");
};

describe("place lookups with a Geoapify key", () => {
  it("asks Geoapify for saved places and moves a miss on to the other services", async () => {
    const qs = [{ q: "Shop One", cc: "jp" }, { q: "Temple Two", cc: "jp" }, { q: "Nothing Three", cc: "jp" }];
    geo.geocodeBatch(qs);
    await until(() => geo.geocodeBatch(qs).pending === 0);
    const res = geo.geocodeBatch(qs).results as Record<string, { name: string; label: string } | null>;
    expect(res["shop one|jp"]?.label).toBe("Shop One, Tokyo, Japan");
    expect(res["temple two|jp"]?.name).toBe("Temple Two");
    expect(res["nothing three|jp"]).toBeNull();
    expect(calls).toContain("G:Shop One");
    expect(calls.filter((c) => c === "N:Nothing Three")).toHaveLength(1);
  }, 20000);
});
