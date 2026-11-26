// Warnings that a model's usage is getting critical, shown above the trip chat's message box (GET /api/usage). Only
// what each service tells is known:
//  - Claude Code: the CLI reports the plan's limits as it answers (rate_limit_event): how much of the 5-hour or weekly
//    limit is used, and when it resets.
//  - Google Gemini: today's requests against the model's daily limit (gemini.ts).
//  - OpenRouter: the key's own spending limit and the account's credit (asked, at most once a minute).
//  - Anthropic and OpenAI have no way to ask a normal key for its credit or spending: what their answers say is noted,
//    a per-minute limit almost used up (headers), and credit that ran out (the error).
// Local models have no limits.
import type { CloudProvider, UsageNotice } from "../../shared/types";
import { getKey, PROVIDERS } from "../keys";
import { geminiNotice } from "./gemini";

/** From this share of a limit used, it's worth saying. */
export const CRITICAL = 0.8;
const BILLING: Partial<Record<CloudProvider, string>> = {
  anthropic: "https://console.anthropic.com/settings/billing", openai: "https://platform.openai.com/settings/organization/billing",
  openrouter: "https://openrouter.ai/settings/credits",
};

// ---- Claude Code's plan limits ----

const LIMIT_NAMES: Record<string, string> = {
  five_hour: "5-hour limit", seven_day: "weekly limit", seven_day_opus: "weekly Opus limit", seven_day_sonnet: "weekly Sonnet limit", overage: "extra usage",
};
const claude = new Map<string, UsageNotice>();

/** A "rate_limit_event" line of the Claude Code CLI's stream. */
export function noteClaudeLimit(info: any) {
  if (!info || typeof info !== "object") return;
  const type = String(info.rateLimitType || "plan"), name = LIMIT_NAMES[type] || "plan limit";
  // A share (0-1), or a percentage.
  const raw = Number(info.utilization), used = Number.isFinite(raw) ? (raw > 1 ? raw / 100 : raw) : undefined;
  const out = info.status === "rejected";
  if (!out && info.status !== "allowed_warning" && !(used != null && used >= CRITICAL)) { claude.delete(type); return; }
  const at = Number(info.resetsAt);
  claude.set(type, {
    level: out ? "out" : "warn", resetsAt: Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : undefined,
    text: out ? `You've reached your Claude ${name}` : used != null ? `You've used ${Math.round(used * 100)}% of your Claude ${name}` : `You're close to your Claude ${name}`,
    url: "https://claude.ai/settings/usage",
  });
}
function claudeNotice(): UsageNotice | null {
  for (const [k, n] of claude) if (n.resetsAt && n.resetsAt <= Date.now()) claude.delete(k);
  const all = [...claude.values()];
  return all.find((n) => n.level === "out") || all[0] || null;
}

// ---- What API answers say (Anthropic, OpenAI, OpenRouter) ----

const outOfCredit = new Map<CloudProvider, UsageNotice>();
const nearMinute = new Map<CloudProvider, UsageNotice>();

/** "6m0s", "1.2s", "450ms" or a date: when, in ms from now on. */
function resetTime(text: string | null): number {
  if (!text) return Date.now() + 60_000;
  const date = Date.parse(text);
  if (/^\d{4}-/.test(text) && date) return date;
  let ms = 0;
  for (const [, n, unit] of text.matchAll(/([\d.]+)(ms|h|m|s)/g)) ms += Number(n) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1);
  return Date.now() + (ms || 60_000);
}

export async function noteResponse(provider: CloudProvider, res: Response) {
  const name = PROVIDERS[provider].name, url = BILLING[provider];
  if (res.ok) outOfCredit.delete(provider);
  else {
    const body = await res.clone().text().catch(() => "");
    if (res.status === 402 || /insufficient_quota|credit balance is too low|insufficient credits|billing_hard_limit/i.test(body)) {
      outOfCredit.set(provider, { level: "out", text: `Your ${name} credit or spending limit is used up`, url });
    }
  }
  for (const what of ["requests", "tokens"]) {
    const h = (kind: string) => res.headers.get(provider === "anthropic" ? `anthropic-ratelimit-${what}-${kind}` : `x-ratelimit-${kind}-${what}`);
    const limit = Number(h("limit")), left = h("remaining");
    if (!limit || left == null || Number(left) / limit > 1 - CRITICAL) continue;
    nearMinute.set(provider, { level: "warn", text: `${name}: ${Math.round((1 - Number(left) / limit) * 100)}% of your ${what} per minute used`, resetsAt: resetTime(h("reset")) });
  }
}

/** fetch that notes what the provider's answer says about its limits. */
export const watchedFetch = (provider: CloudProvider) => async (input: string | URL | Request, init?: RequestInit) => {
  const res = await fetch(input, init);
  await noteResponse(provider, res).catch(() => {});
  return res;
};

// ---- OpenRouter's key and credit ----

let router: { at: number; key: string; notice: UsageNotice | null } | null = null;
const money = (n: number) => `$${Math.max(0, n).toFixed(2)}`;

/** The key's spending limit, then the account's credit (where the key may read it), whichever is critical. */
export function openRouterUsage(keyInfo: any, credits: any): UsageNotice | null {
  const url = BILLING.openrouter, limit = Number(keyInfo?.limit), left = Number(keyInfo?.limit_remaining);
  if (limit > 0 && Number.isFinite(left) && 1 - left / limit >= CRITICAL) {
    return { level: left <= 0 ? "out" : "warn", text: left <= 0 ? "This OpenRouter key's spending limit is used up" : `You've used ${Math.round((1 - left / limit) * 100)}% of this OpenRouter key's limit (${money(left)} left)`, url };
  }
  const total = Number(credits?.total_credits), used = Number(credits?.total_usage);
  if (total > 0 && Number.isFinite(used) && (1 - (total - used) / total >= 0.9 || total - used < 1)) {
    const rest = total - used;
    return { level: rest <= 0 ? "out" : "warn", text: rest <= 0 ? "Your OpenRouter credit is used up" : `Your OpenRouter credit is running low (${money(rest)} left)`, url };
  }
  return null;
}

async function openRouterNotice(): Promise<UsageNotice | null> {
  const key = getKey("openrouter");
  if (!key) return null;
  if (router && router.key === key && Date.now() - router.at < 60_000) return router.notice;
  const base = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const get = async (path: string) => {
    try {
      const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      return res.ok ? ((await res.json()) as any).data : null;
    } catch { return null; }
  };
  router = { at: Date.now(), key, notice: openRouterUsage(await get("/key"), await get("/credits")) };
  return router.notice;
}

/** The warning for a model's id (as in the Model menu), or null while nothing is critical. */
export async function usageNotice(modelId: string): Promise<UsageNotice | null> {
  if (modelId.startsWith("local|")) return null;
  if (!modelId.startsWith("api|")) return claudeNotice();
  const [, provider, ...rest] = modelId.split("|") as [string, CloudProvider, ...string[]];
  if (provider === "gemini") return geminiNotice(rest.join("|"));
  const out = outOfCredit.get(provider);
  if (out) return out;
  const asked = provider === "openrouter" ? await openRouterNotice() : null;
  if (asked) return asked;
  const near = nearMinute.get(provider);
  if (near && near.resetsAt! <= Date.now()) { nearMinute.delete(provider); return null; }
  return near || null;
}
