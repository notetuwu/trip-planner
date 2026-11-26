// Plan a route with "however long" a travel day: the model is asked for a surprise anywhere (keeping what's ruled out),
// flights stay flights though they drive on the ground, and no leg counts as too long.
import { describe, expect, it, vi } from "vitest";

let asked = "";
vi.mock("../server/ai/ask", () => ({ askModel: async (_m: string, prompt: string) => { asked = prompt; return JSON.stringify({ title: "Far", summary: "",
  stays: [{ city: "Kyoto", country: "Japan", nights: 3, travel: "flight" }, { city: "Nara", country: "Japan", nights: 1, travel: "train" }], homeTravel: "flight" }); } }));
vi.mock("../server/geo/geocode", () => ({ locateTown: async (q: string) => (q.startsWith("Kyoto") ? { lat: 35, lng: 135.7 } : q.startsWith("Nara") ? { lat: 34.7, lng: 136.5 } : { lat: 48, lng: 11 }) }));
vi.mock("../server/geo/routing", () => ({ waitForRoute: async () => ({ d: 5_000_000, t: 200_000 }) }));
vi.mock("../server/trip/stops", () => ({ townAt: async () => null }));
const { planRoute } = await import("../server/trip/route-plan");

describe("plan a route, however long a day", () => {
  it("asks for a surprise anywhere and keeps flights", async () => {
    const plan = await planRoute({ start: "Munich", startDate: "2027-04-01", days: 5, mode: "car", maxHours: 0, description: "", model: "default" });
    expect(asked).toMatch(/entirely your choice, anywhere in the world/);
    expect(asked).toMatch(/however long it takes/);
    expect(asked).toContain("no preferences: surprise them");
    expect(asked).not.toMatch(/at most about/);
    expect(plan.stays.map((s) => s.travel)).toEqual(["flight", "car"]);
    expect(plan.homeTravel).toBe("flight");
    expect(plan.legs.some((l) => l.tooLong)).toBe(false);
  });

  it("keeps the daily limit otherwise", async () => {
    await planRoute({ start: "Munich", startDate: "2027-04-01", days: 5, mode: "car", maxHours: 5, description: "lakes", model: "default" });
    expect(asked).toMatch(/at most about 5 h/);
    expect(asked).not.toMatch(/Surprise them/);
  });
});

describe("the route chat", () => {
  it("offers to just answer a question, only while a route is being talked about", async () => {
    await planRoute({ start: "Munich", startDate: "2027-04-01", days: 5, mode: "car", maxHours: 5, description: "lakes", model: "default",
      conversation: [{ route: "Kyoto (4 nights)", said: "why Kyoto?", qa: [{ q: "is it far?", a: "Yes." }] }] });
    expect(asked).toContain('reply with only {"answer": "your answer"}');
    expect(asked).toContain('They asked: "is it far?"');
    await planRoute({ start: "Munich", startDate: "2027-04-01", days: 5, mode: "car", maxHours: 5, description: "lakes", model: "default" });
    expect(asked).not.toContain('{"answer"');
  });
});
