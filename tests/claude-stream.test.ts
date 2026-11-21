import { describe, expect, it } from "vitest";
import { claudeStreamHandler } from "../server/ai/claude-stream";

describe("Claude stream (Anthropic API events)", () => {
  it("reports searches, their results, notes, thinking and itinerary progress", () => {
    const events: any[] = [];
    const h = claudeStreamHandler((e) => events.push(e), "submit_itinerary");
    const raw = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Kyoto has many temples to weigh up" } },
      { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "s1", name: "web_search" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"Kinkaku-ji hours"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", title: "Kinkaku-ji", url: "https://example.org/k" }] } },
      { type: "content_block_start", index: 3, content_block: { type: "text" } },
      { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "- Temples first" } },
      { type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "t1", name: "submit_itinerary" } },
      { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"days":[{"date":"2026-04-01"},{"date":"2026-04-02"}' } },
      { type: "message_delta", usage: { output_tokens: 1200 } },
    ];
    raw.forEach(h.event);
    expect(events).toContainEqual({ type: "search", query: "Kinkaku-ji hours" });
    expect(events.find((e) => e.label === "Result of web_search")?.text).toContain("https://example.org/k");
    expect(events).toContainEqual({ type: "text", text: "- Temples first" });
    expect(events).toContainEqual({ type: "progress", days: 2 });
    expect(events.some((e) => e.type === "thinking" && e.tokens > 0)).toBe(true);
    expect(h.state.reasoning).toBe("- Temples first");
    expect(h.state.thinking).toContain("temples");
    expect(events.at(-1)).toMatchObject({ type: "tokens", count: 1200 });
  });
});
