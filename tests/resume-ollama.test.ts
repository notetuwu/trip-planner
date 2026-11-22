// A local model that runs out of room after part of the trip: the finished days are kept and only the rest is asked
// for (the same prompt with that added), then the two are joined into one plan.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Trip } from "../server/ai/types";

let planWithOllama: typeof import("../server/ai/local-ollama").planWithOllama;
let localOutput: typeof import("../server/ai/local-output").localOutput;
const asked: string[] = [];

const day = (k: number) => ({ date: `2026-11-0${k}`, city: "Kyoto", title: `Day ${k}`, estimatedCost: 100, items: [{ time: "10:00", place: `Temple ${k}`, description: "Walk." }] });
const lines = (chunks: object[]) => new Response(chunks.map((c) => JSON.stringify(c)).join("\n") + "\n");

beforeAll(async () => {
  process.env.TRIP_PLANNER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-resume-"));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/api/show")) return new Response(JSON.stringify({ capabilities: [], model_info: { "x.context_length": 131072 } }));
    const body = JSON.parse(String(init.body));
    asked.push(body.messages[0].content);
    if (asked.length === 1) {
      // Two days written, the third cut off: out of room.
      const json = JSON.stringify({ planningNotes: "First part", summary: "Four days in Kyoto", destination: "Japan", days: [day(1), day(2), day(3)] });
      return lines([{ message: { content: json.slice(0, json.indexOf('"Temple 3"')) } }, { done: true, done_reason: "length", eval_count: 900 }]);
    }
    return lines([{ message: { content: JSON.stringify({ planningNotes: "Second part", summary: "rest", destination: "Japan", days: [day(3), day(4)], tips: ["Carry cash"], totalEstimatedCost: 200 }) } }, { done: true, eval_count: 400 }]);
  }));
  ({ planWithOllama } = await import("../server/ai/local-ollama"));
  ({ localOutput } = await import("../server/ai/local-output"));
});
afterAll(() => vi.unstubAllGlobals());

describe("running out of room part way through the trip", () => {
  it("keeps the finished days and asks only for the rest", async () => {
    const events: any[] = [];
    const output = localOutput((e) => events.push(e));
    const trip = { stays: [{ city: "Kyoto", start: "2026-11-01", nights: 3 }], travelers: 2 } as unknown as Trip;
    await planWithOllama({ base: "http://127.0.0.1:11434", model: "m", prompt: "PROMPT", trip, abort: new AbortController().signal, onEvent: (e) => events.push(e), output });
    expect(asked).toHaveLength(2);
    expect(asked[1].startsWith("PROMPT")).toBe(true); // the same prompt, so Ollama can reuse what it read
    expect(asked[1]).toContain("2026-11-01 Kyoto: Temple 1");
    expect(asked[1]).toContain("Continue the itinerary from the day after 2026-11-02 to the end of the trip (2026-11-04)");
    const plan = JSON.parse(output.out.content);
    expect(plan.days.map((d: any) => d.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(plan.summary).toBe("Four days in Kyoto");
    expect(plan.tips).toEqual(["Carry cash"]);
    expect(plan.totalEstimatedCost).toBe(400);
    expect(events.some((e) => e.type === "status" && /after 2 of 4 days; keeping those/.test(e.text))).toBe(true);
  });
});
