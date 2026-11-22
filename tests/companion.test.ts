// The trip chat's prompt: the trip, the conversation so far (only the last turns), and the question; answers cleaned.
import { describe, expect, it } from "vitest";
import { cleanAnswer, companionPrompt } from "../server/trip/companion";

describe("trip chat", () => {
  it("puts the trip, the recent conversation and the question in the prompt", () => {
    const history = Array.from({ length: 20 }, (_, k) => ({ role: (k % 2 ? "ai" : "me") as "me" | "ai", text: `turn ${k}` }));
    const p = companionPrompt({ model: "m", question: "Where do we eat on day 2?", context: "Day 2 · Padua", history, today: "2027-09-14" });
    expect(p).toContain("Day 2 · Padua");
    expect(p).toContain("Traveler: turn 18");
    expect(p).toContain("You: turn 19");
    expect(p).not.toContain("turn 7\n");
    expect(p.trim().endsWith("Where do we eat on day 2?")).toBe(true);
    expect(p).toContain("Today is 2027-09-14");
  });
  it("says when nothing is planned yet", () => {
    expect(companionPrompt({ model: "m", question: "Ideas?" })).toContain("Nothing planned yet");
  });
  it("strips code fences and speaker labels", () => {
    expect(cleanAnswer("```markdown\nHello **there**\n```")).toBe("Hello **there**");
    expect(cleanAnswer("You: Take the train.")).toBe("Take the train.");
  });
});
