// A real step-by-step plan with a local Ollama model: only with LIVE_MODEL set (e.g. LIVE_MODEL=qwen3.8:27b), since
// it needs the model and takes minutes. Checks that every step comes back and the days hold the outline's places.
import { describe, expect, it } from "vitest";
import { planInSteps } from "../server/ai/local-steps";

const MODEL = process.env.LIVE_MODEL;

describe.skipIf(!MODEL)("step-by-step planning with a real local model", () => {
  it("outlines, then writes every day", async () => {
    const trip: any = {
      model: `local|ollama|http://127.0.0.1:11434|${MODEL}`, travelers: 2, dailyBudget: 80, budgetPer: "person", currency: "EUR",
      pace: "balanced (3-5 stops per day)", interests: "castles, food markets, vegan food", notes: "", research: false,
      stays: [{ city: "Osaka", start: "2026-11-02", nights: 3, hotel: "", lat: 34.6937, lng: 135.5023, country: "Japan", cc: "jp" }],
      mustSee: ["Osaka Castle"], skip: [],
      holidays: [{ date: "2026-11-03", cc: "JP", name: "Culture Day", localName: "文化の日" }],
    };
    const places: any[] = [
      { title: "Osaka Castle", lat: 34.6873, lng: 135.5262 },
      { title: "Kuromon Market", lat: 34.6654, lng: 135.5065 },
      { title: "Dotonbori", lat: 34.6687, lng: 135.5013 },
      { title: "Shinsekai", lat: 34.6525, lng: 135.5063 },
      { title: "Osaka Aquarium Kaiyukan", lat: 34.6545, lng: 135.4290 },
      { title: "Umeda Sky Building", lat: 34.7053, lng: 135.4906 },
    ];
    const events: any[] = [];
    const t0 = Date.now();
    const r = await planInSteps(trip, places, (e) => { events.push(e); if (e.type === "status") console.log(`${Math.round((Date.now() - t0) / 1000)}s ${e.text}`); }, new AbortController().signal);
    for (const d of r.itinerary.days) console.log(`${d.date} ${d.city}: ${d.title}\n  ${d.items.map((x) => `${x.time} ${x.place}`).join("\n  ")}`);
    console.log(r.reasoning.slice(0, 600));
    expect(r.itinerary.days.map((d) => d.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(r.itinerary.days.flatMap((d) => d.items.map((x) => x.place)).join(" ")).toContain("Osaka Castle");
    expect(r.itinerary.days.every((d) => d.items.length > 0 && d.items.every((x) => /^\d\d:\d\d/.test(x.time)))).toBe(true);
  }, 30 * 60_000);
});
