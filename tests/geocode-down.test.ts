// A lookup service that can't be reached (Photon was, from one home connection): after three failures it's left out
// for a while and everything goes through the other one; places not found there are remembered, so nothing stays
// "locating" forever.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let geo: typeof import("../server/geo/geocode");
const calls: string[] = [];

beforeAll(async () => {
  process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-geodown-"));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = new URL(String(url)), q = u.searchParams.get("q") || "";
    if (u.hostname.startsWith("photon")) { calls.push(`P:${q}`); throw new TypeError("fetch failed"); }
    calls.push(`N:${q}`);
    return new Response(JSON.stringify(q.startsWith("Found") ? [{ lat: "34.4", lon: "132.4", name: q, display_name: `${q}, Japan`, address: { country: "Japan", country_code: "jp" }, type: "attraction", category: "tourism" }] : []));
  }));
  geo = await import("../server/geo/geocode");
});
afterAll(() => vi.unstubAllGlobals());

const until = async (ok: () => boolean, ms = 20000) => {
  for (const t0 = Date.now(); !ok(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() - t0 > ms) throw new Error("timed out");
};

describe("a lookup service that can't be reached", () => {
  it("is left out after three failures; the rest goes through the other service and every answer is kept", async () => {
    const qs = ["Found 1", "Missing 2", "Found 3", "Missing 4", "Found 5"].map((q) => ({ q, cc: "jp" })); // saved places: Photon first
    expect(geo.geocodeBatch(qs).pending).toBe(5);
    await until(() => geo.geocodeBatch(qs).pending === 0);
    const res = geo.geocodeBatch(qs).results as Record<string, { name: string } | null>;
    expect(res["found 1|jp"]?.name).toBe("Found 1");
    expect(res["missing 2|jp"]).toBeNull(); // not found by Nominatim: remembered, not retried forever
    expect(calls.filter((c) => c.startsWith("P:")), calls.join(" ")).toHaveLength(3); // Photon given up on after three failures
    const status = geo.geocodeStatus();
    expect(status.down.map((d) => d.lane)).toEqual(["photon"]);
    expect(status.events.some((e) => e.result === "error")).toBe(true);
  }, 30000);
});
