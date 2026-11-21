import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Itinerary } from "../shared/types";
import { pageExists, verifyWebsites } from "../server/ai/verify-links";

// A tiny local site: /ok exists, /blocked refuses robots (still exists), everything else is missing.
let base = "";
const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/ok" ? 200 : req.url === "/blocked" ? 403 : 404).end("x");
});
beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); })));
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("checking the websites a model gives", () => {
  it("keeps pages that exist, even if they block robots", async () => {
    expect(await pageExists(`${base}/ok`)).toBe(true);
    expect(await pageExists(`${base}/blocked`)).toBe(true);
  });
  it("drops missing pages and nonsense", async () => {
    expect(await pageExists(`${base}/nope`)).toBe(false);
    expect(await pageExists("not a url")).toBe(false);
  });
  it("removes invented websites from the itinerary", async () => {
    const it: Itinerary = { summary: "", totalEstimatedCost: 0, days: [{ date: "2027-09-18", city: "Luzern", title: "", estimatedCost: 0, items: [
      { time: "09:00", place: "Real", description: "", website: `${base}/ok` },
      { time: "10:00", place: "Invented", description: "", website: `${base}/made-up` },
      { time: "11:00", place: "None", description: "" },
    ] }] };
    const status: string[] = [];
    expect(await verifyWebsites(it, (s) => status.push(s))).toBe(1);
    expect(it.days[0].items.map((x) => x.website)).toEqual([`${base}/ok`, undefined, undefined]);
    expect(status[0]).toContain("Checking 2 websites");
  });
  it("removes dead links from tips and keeps live ones", async () => {
    const it: Itinerary = { summary: "", totalEstimatedCost: 0, days: [{ date: "d", city: "", title: "", estimatedCost: 0, items: [] }],
      tips: [`Buy the vignette online at ${base}/ok.`, `Get a pass (${base}/gone).`, `Fake one: see ${base}/gone`] };
    await verifyWebsites(it, () => {});
    expect(it.tips).toEqual([`Buy the vignette online at ${base}/ok.`, "Get a pass.", "Fake one:"]);
  });
});
