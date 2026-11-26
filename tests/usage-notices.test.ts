// The chat's usage warnings: Claude Code's plan limits from its rate_limit_event, OpenRouter's key limit and credit,
// and what Anthropic's and OpenAI's answers say (a per-minute limit nearly used, credit run out).
import { describe, expect, it } from "vitest";
import { noteClaudeLimit, noteResponse, openRouterUsage, usageNotice } from "../server/ai/usage-notices";

describe("usage warnings", () => {
  it("warns about a Claude plan limit once it's critical, and stops when it's fine again", async () => {
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    noteClaudeLimit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.4, resetsAt });
    expect(await usageNotice("sonnet")).toBeNull();
    noteClaudeLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.89, resetsAt });
    expect(await usageNotice("sonnet")).toMatchObject({ level: "warn", text: "You've used 89% of your Claude weekly limit", resetsAt: resetsAt * 1000 });
    noteClaudeLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt });
    expect(await usageNotice("default")).toMatchObject({ level: "out", text: "You've reached your Claude 5-hour limit" });
    noteClaudeLimit({ status: "allowed", rateLimitType: "five_hour" });
    noteClaudeLimit({ status: "allowed", rateLimitType: "seven_day" });
    expect(await usageNotice("sonnet")).toBeNull();
    expect(await usageNotice("local|ollama|http://x|m")).toBeNull();
  });

  it("warns about an OpenRouter key's limit or low credit", () => {
    expect(openRouterUsage({ limit: 10, limit_remaining: 8 }, null)).toBeNull();
    expect(openRouterUsage({ limit: 10, limit_remaining: 1 }, null)?.text).toContain("90% of this OpenRouter key's limit ($1.00 left)");
    expect(openRouterUsage({ limit: null }, { total_credits: 20, total_usage: 19.5 })?.text).toContain("$0.50 left");
    expect(openRouterUsage({ limit: null }, { total_credits: 0, total_usage: 0 })).toBeNull();
  });

  it("notes a per-minute limit nearly used, and credit that ran out until a request works again", async () => {
    const headers = { "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "50", "x-ratelimit-reset-tokens": "30s" };
    await noteResponse("openai", new Response("{}", { headers }));
    expect((await usageNotice("api|openai|gpt"))?.text).toBe("OpenAI: 95% of your tokens per minute used");
    await noteResponse("openai", new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }));
    expect(await usageNotice("api|openai|gpt")).toMatchObject({ level: "out" });
    await noteResponse("openai", new Response("{}"));
    expect((await usageNotice("api|openai|gpt"))?.level).toBe("warn");
  });
});
