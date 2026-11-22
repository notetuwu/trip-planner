// The trip chat's prompt: the trip, the conversation so far (only the last turns), and the question; answers cleaned;
// changes to the plan read from the reply's last line.
import { describe, expect, it } from "vitest";
import { cleanAnswer, companionPrompt, parseChange } from "../server/trip/companion";


describe("trip chat", () => {
  it("puts the trip, the recent conversation and the question in the prompt", () => {
    const history = Array.from({ length: 20 }, (_, k) => ({ role: (k % 2 ? "ai" : "me") as "me" | "ai", text: `turn ${k}` }));
    const p = companionPrompt({ model: "m", question: "Where do we eat on day 2?", context: "Day 2 · Padua", history, today: "2027-09-14", days: 5 });
    expect(p).toContain("Day 2 · Padua");
    expect(p).toContain("Traveler: turn 18");
    expect(p).toContain("You: turn 19");
    expect(p).not.toContain("turn 7\n");
    expect(p.trim().endsWith("Where do we eat on day 2?")).toBe(true);
    expect(p).toContain("Today is 2027-09-14");
    expect(p).toContain("change their 5-day itinerary");
  });
  it("without a plan: no changes offered", () => {
    const p = companionPrompt({ model: "m", question: "Ideas?" });
    expect(p).toContain("Nothing planned yet");
    expect(p).not.toContain("CHANGE:");
  });
  it("strips code fences, speaker labels and the change line", () => {
    expect(cleanAnswer("```markdown\nHello **there**\n```")).toBe("Hello **there**");
    expect(cleanAnswer("You: Take the train.")).toBe("Take the train.");
    expect(cleanAnswer('Swapping them.\nCHANGE: {"days": [3, 4], "request": "swap"}')).toBe("Swapping them.");
    expect(cleanAnswer("Swapping them.\nCHAN")).toBe("Swapping them.");
  });
  it("reads the change: days within the plan, an instruction", () => {
    expect(parseChange('Ok.\nCHANGE: {"days": [4, 3, 3, 9], "request": "Swap days 3 and 4"}', 5)).toEqual({ days: [3, 4], request: "Swap days 3 and 4" });
    expect(parseChange('CHANGE: {"days": [], "request": "More museums"}', 5)).toEqual({ days: [], request: "More museums" });
    expect(parseChange('CHANGE: {"days": [2]}', 5)).toBeNull();
    expect(parseChange("No change here.", 5)).toBeNull();
  });
  it("reads setup changes (on the way, day trips), also without a change to the days", () => {
    const c = parseChange('Done.\nCHANGE: {"days": [], "request": "", "trip": {"onTheWay": ["Burg Hohenwerfen"], "removeDayTrips": [{"stay": "Salzburg", "place": "Burg Hohenwerfen"}], "addDayTrips": [{"stay": "Salzburg", "place": "Hallstatt", "mode": "boat"}], "fromStay": []}}', 18);
    expect(c).toEqual({ days: [], request: "", trip: {
      onTheWay: ["Burg Hohenwerfen"], removeDayTrips: [{ stay: "Salzburg", place: "Burg Hohenwerfen" }], addDayTrips: [{ stay: "Salzburg", place: "Hallstatt", mode: "car" }],
    } });
    expect(parseChange('CHANGE: {"days": [2], "request": "", "trip": {}}', 5)).toBeNull();
  });
  it("tells the model how to change the setup", () => {
    expect(companionPrompt({ model: "m", question: "x", days: 3 })).toContain('"onTheWay": places to visit on a travel day between two stays');
  });
});
