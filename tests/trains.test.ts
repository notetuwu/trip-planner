// The train connections section of the prompt.
import { describe, expect, it } from "vitest";
import { trainsSection } from "../server/ai/prompt-sections";

describe("train connections", () => {
  it("go into the prompt as facts to route by", () => {
    const s = trainsSection({ trains: ["- Osaka → Hakone: 新大阪 → 小田原 (ひかり658号, high-speed train); about 2 h 41 min door to door"] });
    expect(s).toContain("## Train connections");
    expect(s).toContain("ひかり658号");
    expect(s).toMatch(/Don't route via other cities/);
    expect(trainsSection({})).toBe("");
  });
});
