// Google Gemini with a stand-in Gemini API: the models list (text models only), the free-tier check (every model gets a
// test request; a quota of 0 tells the free tier), requests counted per model per quota day, a per-minute limit waited
// out once, a used-up daily limit switching to the next model (and an error in words once none is left), and a model
// without Google Search on this tier researching through the planner's own search tools instead.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Trip } from "../server/ai/types";

let server: http.Server, mode: "ok" | "minute" | "day" = "ok", liteDay = false;
const seen: string[] = [], bodies: { url: string; body: string }[] = [];
let gemini: typeof import("../server/ai/gemini"), ask: typeof import("../server/ai/ask");

const quota = (perDay: boolean, limit: number, model: string, retry = "1s") => JSON.stringify({ error: {
  code: 429, status: "RESOURCE_EXHAUSTED", message: `You exceeded your current quota. limit: ${limit}, model: ${model}`,
  details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{
      quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
      quotaId: perDay ? "GenerateRequestsPerDayPerProjectPerModel-FreeTier" : "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
      quotaDimensions: { location: "global", model }, quotaValue: String(limit),
    }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: retry },
  ],
} });

beforeAll(async () => {
  let minuteHit = false;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      bodies.push({ url: req.url || "", body });
      if (req.headers["x-goog-api-key"] !== "test-key" && req.headers.authorization !== "Bearer test-key") { res.writeHead(400); res.end(JSON.stringify({ error: { message: "API key not valid." } })); return; }
      // The OpenAI-compatible endpoint, researching: it sums up straight away (no tool calls, so nothing is searched).
      if (req.url === "/openai/chat/completions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "- Kinkaku-ji is open 9:00-17:00 [https://example.org/kinkakuji]" } }] }));
        return;
      }
      // Flash Lite: answers, but Google Search isn't included for it (a search-grounding quota of 0).
      if (req.url === "/models/gemini-9-flash-lite:generateContent") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "H" }] }, finishReason: "MAX_TOKENS" }] })); return;
      }
      if (req.url === "/models/gemini-9-flash-lite:streamGenerateContent?alt=sse") {
        if (liteDay) { res.writeHead(429); res.end(quota(true, 500, "gemini-9-flash-lite")); return; }
        if (body.includes("google_search")) { res.writeHead(429); res.end(quota(true, 0, "gemini-9-flash-lite").replace(/GenerateRequestsPerDayPerProjectPerModel-FreeTier/, "SearchGroundingRequestsPerDayPerProjectPerModel-FreeTier")); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const plan = body.includes("Kinkaku-ji")
          ? { summary: "Kyoto", totalEstimatedCost: 0, days: ["2026-04-01", "2026-04-02", "2026-04-03"].map((date) => ({ date, city: "Kyoto", title: "Kyoto", estimatedCost: 0, items: [{ time: "10:00", place: "Kinkaku-ji", description: "" }] })) }
          : { stays: [{ city: "Osaka" }] };
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] }, finishReason: "STOP" }] })}\r\n\r\n`);
        res.end();
        return;
      }
      if (req.url?.startsWith("/models?")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [
          { name: "models/gemini-9-flash", displayName: "Gemini 9 Flash", supportedGenerationMethods: ["generateContent"], outputTokenLimit: 65536 },
          { name: "models/gemini-9-pro", displayName: "Gemini 9 Pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-9-flash-lite", displayName: "Gemini 9 Flash Lite", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-8-flash", displayName: "Gemini 8 Flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-9-flash-tts", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemma-5-27b", supportedGenerationMethods: ["generateContent"] },
        ] }));
        return;
      }
      // The test requests: the Pro model has none on the free tier, the old Flash is retired, the new Flash answers.
      if (req.url === "/models/gemini-9-pro:generateContent") { res.writeHead(429); res.end(quota(true, 0, "gemini-9-pro")); return; }
      if (req.url === "/models/gemini-8-flash:generateContent") {
        res.writeHead(404); res.end(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "This model models/gemini-8-flash is no longer available to new users." } })); return;
      }
      if (req.url === "/models/gemini-9-flash:generateContent") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "H" }] }, finishReason: "MAX_TOKENS" }] })); return;
      }
      if (req.url === "/models/gemini-9-flash:streamGenerateContent?alt=sse") {
        if (mode === "day") { res.writeHead(429); res.end(quota(true, 20, "gemini-9-flash")); return; }
        if (mode === "minute" && !minuteHit) { minuteHit = true; res.writeHead(429); res.end(quota(false, 5, "gemini-9-flash")); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\r\n\r\n`);
        send({ candidates: [{ content: { parts: [{ text: "Thinking about stays.", thought: true }] } }] });
        send({ candidates: [{ content: { parts: [{ text: '{"stays": [' }] } }] });
        send({ candidates: [{ content: { parts: [{ text: '{"city": "Kyoto"}]}' }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 120 } });
        res.end();
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-"));
  gemini = await import("../server/ai/gemini");
  ask = await import("../server/ai/ask");
});
afterAll(() => { server.closeAllConnections(); server.close(); delete process.env.GEMINI_BASE_URL; delete process.env.GEMINI_API_KEY; });

describe("Google Gemini", () => {
  it("reads a quota error: daily or per minute, its limit, the model and whether it's the free tier", () => {
    const day = gemini.readError(429, quota(true, 20, "gemini-9-flash", "41s"));
    expect(day.quota).toMatchObject({ perDay: true, limit: 20, model: "gemini-9-flash", freeTier: true, retrySec: 41 });
    expect(gemini.readError(429, quota(false, 5, "gemini-9-flash")).quota).toMatchObject({ perDay: false, limit: 5 });
    expect(gemini.readError(400, JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } })).keyProblem).toBe(true);
  });

  it("tells a 400/403 about the region or billing from a refused key", () => {
    const err = (status: number, message: string, s = "PERMISSION_DENIED") => gemini.readError(status, JSON.stringify({ error: { code: status, status: s, message } }));
    const region = err(400, "User location is not supported for the API use without a billing account linked.", "FAILED_PRECONDITION");
    expect([region.region, region.keyProblem]).toEqual([true, false]);
    const billing = err(403, "This model requires a paid billing setup. Please enable billing for your project.");
    expect([billing.billing, billing.keyProblem]).toEqual([true, false]);
    expect(err(403, "Method doesn't allow unregistered callers (callers without established identity). Please use API Key.").keyProblem).toBe(true);
  });

  it("goes by Google's quota day, midnight to midnight Pacific time", () => {
    // 07:30 UTC on 26 November is 23:30 the day before in California (standard time, UTC−8).
    const q = gemini.quotaDay(Date.parse("2026-11-26T07:30:00Z"));
    expect(q.day).toBe("2026-11-25");
    expect(new Date(q.resetAt).toISOString()).toBe("2026-11-26T08:00:00.000Z");
  });

  it("lists the text models, newest first", async () => {
    const models = await gemini.geminiModels("test-key");
    expect(models.map((m) => m.id)).toEqual(["api|gemini|gemini-9-flash", "api|gemini|gemini-9-flash-lite", "api|gemini|gemini-9-pro", "api|gemini|gemini-8-flash"]);
  });

  it("tries every listed model: tells the free tier by a quota of 0, and offers only the models that answered", async () => {
    const s = await gemini.geminiStatus();
    expect(s.tier).toBe("free");
    expect(s.tierNote).toMatch(/2 of 4 models answered \(gemini-9-flash, gemini-9-flash-lite\)/);
    expect(Object.fromEntries(s.access.map((a) => [a.model, a.state]))).toEqual({ "gemini-9-flash": "ok", "gemini-9-flash-lite": "ok", "gemini-9-pro": "billing", "gemini-8-flash": "gone" });
    expect(s.models.find((m) => m.model === "gemini-9-pro")?.perDay).toBe(0);
    for (const m of ["gemini-9-flash", "gemini-9-pro", "gemini-8-flash"]) expect(seen).toContain(`POST /models/${m}:generateContent`);
    const usable = await gemini.usableGemini(await gemini.geminiModels("test-key"));
    expect(usable.map((m) => m.id)).toEqual(["api|gemini|gemini-9-flash", "api|gemini|gemini-9-flash-lite"]);
  });

  it("tells a paid key: every available model answers, Pro included", () => {
    // (The free-tier quota is what tells them apart; a 429 with a paid quota still counts as usable.)
    const paid = gemini.readError(429, quota(true, 1000, "gemini-9-pro").replace(/-FreeTier/g, "").replace(/_free_tier/g, ""));
    expect(paid.quota).toMatchObject({ freeTier: false, limit: 1000 });
  });

  it("answers through askModel, counting the request and its tokens for today", async () => {
    const thoughts: string[] = [];
    const text = await ask.askModel("api|gemini|gemini-9-flash", "Plan", () => {}, { onText: (_r, t) => thoughts.push(t) });
    expect(JSON.parse(text).stays[0].city).toBe("Kyoto");
    expect(thoughts.at(-1)).toContain("Thinking about stays.");
    const use = (await gemini.geminiStatus()).models.find((m) => m.model === "gemini-9-flash");
    expect(use).toMatchObject({ requests: 2, tokens: 120 }); // the test request, then this one
  });

  it("waits out a per-minute limit once, then goes on", async () => {
    mode = "minute";
    const waits: string[] = [];
    const text = await ask.askModel("api|gemini|gemini-9-flash", "Plan", () => {}, { onRetry: (m) => waits.push(m) });
    expect(JSON.parse(text).stays).toHaveLength(1);
    expect(waits[0]).toMatch(/per-minute limit .* waiting 1 seconds/);
    expect((await gemini.geminiStatus()).models.find((m) => m.model === "gemini-9-flash")?.perMinute).toBe(5);
  }, 10000);

  it("without Google Search on this tier, researches with the planner's own search tools, then plans with the findings", async () => {
    const trip = {
      dailyBudget: 150, currency: "EUR", travelers: 2, pace: "balanced", model: "api|gemini|gemini-9-flash-lite", interests: "", notes: "", list: "",
      extraPlaces: [], research: true, mustSee: [], mustSeeWho: {}, skip: [],
      stays: [{ city: "Kyoto", start: "2026-04-01", nights: 2, hotel: "" }],
    } as unknown as Trip;
    const events: any[] = [];
    const result = await gemini.runGemini(trip, [], (e) => events.push(e), new AbortController().signal);
    // Asked with Google Search, refused (a search-grounding quota of 0), researched through the planner, asked again.
    expect(seen).toContain("POST /openai/chat/completions");
    const asks = bodies.filter((b) => b.url === "/models/gemini-9-flash-lite:streamGenerateContent?alt=sse");
    expect(asks[0].body).toContain("google_search");
    expect(asks.at(-1)!.body).not.toContain("google_search");
    expect(asks.at(-1)!.body).toContain("Kinkaku-ji is open 9:00-17:00");
    expect(result.itinerary.days[0].items[0].place).toBe("Kinkaku-ji");
    expect(result.reasoning).toMatch(/researched with the planner's own web search/);
    expect(result.engine).toMatch(/researched through the planner/);
    expect(result.itinerary.sources).toContain("https://example.org/kinkakuji");
    expect(events.some((e) => e.type === "status" && /Google Search isn't included/.test(e.text))).toBe(true);
    // Remembered: the next plan researches through the planner straight away, without asking for Google Search first.
    const before = bodies.length;
    await gemini.runGemini(trip, [], () => {}, new AbortController().signal);
    expect(bodies.slice(before).some((b) => b.body.includes("google_search"))).toBe(false);
  });

  it("stays on a picked model: its used-up daily limit is an error, not another model", async () => {
    mode = "day";
    const before = seen.length;
    await expect(ask.askModel("api|gemini|gemini-9-flash", "Plan")).rejects.toThrow(/free tier allows 20 requests a day with gemini-9-flash.*Gemini Auto/s);
    expect(seen.slice(before).some((x) => x.includes("gemini-9-flash-lite"))).toBe(false);
  });

  it("on Auto, goes on with the next model the key can run when one reaches its daily limit", async () => {
    mode = "day";
    // As on a new day: Flash is tried again.
    const file = path.join(process.env.TRIP_PLANNER_DATA!, "gemini-usage.json"), u = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...u, exhausted: [] }));
    const notes: string[] = [];
    const text = await ask.askModel("api|gemini|auto", "Plan", () => {}, { onRetry: (m) => notes.push(m) });
    expect(JSON.parse(text).stays[0].city).toBe("Osaka"); // Flash Lite's answer
    expect(notes).toContain("gemini-9-flash has used today's 20 requests. Going on with gemini-9-flash-lite…");
    const s = await gemini.geminiStatus();
    expect(s.limited).toMatchObject({ model: "gemini-9-flash", perDay: true, limit: 20 });
    expect(s.models.find((m) => m.model === "gemini-9-flash")).toMatchObject({ requests: 3, perDay: 20 });
  });

  it("says so in words once every usable model is at its limit", async () => {
    liteDay = true;
    await expect(ask.askModel("api|gemini|auto", "Plan")).rejects.toThrow(/free tier allows 500 requests a day with gemini-9-flash-lite|No Gemini model this key can run has requests left/);
  });
});