// The chat's usage warnings: Claude Code's plan limits from its rate_limit_event, OpenRouter's key limit and credit,
// and what Anthropic's and OpenAI's answers say (a per-minute limit nearly used, credit run out).
import { describe, expect, it, vi } from "vitest";
import { readPlanUsage } from "../server/ai/claude-usage";
import { noteClaudeLimit, noteResponse, openRouterUsage, planNotice, usageInfo, usageNotice } from "../server/ai/usage-notices";

// The installed CLI isn't asked here: only what it reports while answering is known.
vi.mock("../server/ai/claude-usage", async (original) => ({ ...await original<object>(), claudePlanUsage: async () => null }));

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

  it("reads the plan's limits as the CLI answers them, and warns about the fullest one that counts", () => {
    const answer = (weekly: number, extra?: object) => ({ subscription_type: "pro", rate_limits_available: true, rate_limits: {
      limits: [
        { kind: "session", group: "session", percent: 29, severity: "normal", resets_at: "2027-01-01T10:00:00.043896+00:00" },
        { kind: "weekly_all", group: "weekly", percent: weekly, severity: "normal", resets_at: "2027-01-05T17:00:00.043920+00:00" },
        { kind: "weekly_scoped", group: "weekly", percent: 99, severity: "critical", scope: { model: { display_name: "Opus" } } },
      ],
      extra_usage: extra,
    } });
    const u = readPlanUsage(answer(94))!;
    expect(u.limits[1]).toEqual({ name: "weekly limit", percent: 94, resetsAt: Date.parse("2027-01-05T17:00:00Z") });
    expect(planNotice(u, "sonnet")?.text).toBe("You've used 94% of your Claude weekly limit");
    expect(planNotice(u, "default")?.text).toBe("You've used 99% of your Claude weekly Opus limit");
    expect(planNotice(readPlanUsage(answer(40))!, "sonnet")).toBeNull();
    expect(planNotice(readPlanUsage(answer(100))!, "sonnet")?.level).toBe("out");
    const paid = readPlanUsage(answer(100, { is_enabled: true, monthly_limit: 8500, used_credits: 1883, decimal_places: 2, currency: "EUR" }))!;
    expect(planNotice(paid, "sonnet")).toMatchObject({ level: "warn", text: "You've reached your Claude weekly limit; now on extra usage (€18.83 of €85.00 spent)" });
    expect(readPlanUsage({ rate_limits_available: false, rate_limits: null })).toBeNull();
  });

  it("shows Anthropic's per-minute limits from its last answer", async () => {
    const h = (what: string, left: number) => ({ [`anthropic-ratelimit-${what}-limit`]: "100", [`anthropic-ratelimit-${what}-remaining`]: String(left) });
    await noteResponse("anthropic", new Response("{}", { headers: { ...h("requests", 98), ...h("tokens", 60), ...h("input-tokens", 70), ...h("output-tokens", 90) } }));
    expect((await usageInfo("api|anthropic|claude")).limits?.list).toEqual([{ name: "requests", percent: 2 }, { name: "input tokens", percent: 30 }, { name: "output tokens", percent: 10 }]);
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
