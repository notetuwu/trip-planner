// The chat's question is shown once: the reply's own closing question is left out of its text.
import { describe, expect, it } from "vitest";
import { withoutClosingQuestion } from "../web/src/trip/chat-ask-text";

describe("withoutClosingQuestion", () => {
  it("drops the question a reply ends on, on its own line or after a sentence", () => {
    expect(withoutClosingQuestion("All are near the hotel area.\n\nWant me to swap one of them into Day 14 in place of Beispielstube?")).toBe("All are near the hotel area.");
    expect(withoutClosingQuestion("- [St. Peter](map:St. Peter, Bozen)\n\nAll are close. Want one? **Which one?**")).toBe("- [St. Peter](map:St. Peter, Bozen)\n\nAll are close.");
  });

  it("leaves other text as it is, and gives nothing when the reply was only the question", () => {
    expect(withoutClosingQuestion("Where to? Anywhere is fine.")).toBe("Where to? Anywhere is fine.");
    expect(withoutClosingQuestion("Which one would you like?")).toBe("");
  });
});
