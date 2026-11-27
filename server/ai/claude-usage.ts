// The Claude plan's limits as Claude Code's own /usage shows them: asked from the CLI (its "get_usage" request, the one
// the editor extensions use), which answers without calling a model, so it costs none of the limits. Older CLIs don't
// know it; then only what the CLI says while answering is known (usage-notices.ts).
import { spawn } from "node:child_process";
import os from "node:os";
import type { UsageLimit } from "../../shared/types";
import { findClaude } from "./claude-bin";

export interface PlanUsage {
  /** "pro", "max", "team"…, "" when not said. */
  plan: string;
  limits: UsageLimit[];
  /** Paid usage beyond the plan, when it's turned on: money spent of the monthly cap. */
  extra?: { used: number; cap: number; currency: string; reached: boolean };
}

/** A reset time to the minute: the CLI's differ by microseconds from one answer to the next. */
const minute = (at: unknown) => { const ms = Date.parse(String(at || "")); return ms ? Math.round(ms / 60_000) * 60_000 : undefined; };
const NAMES: Record<string, string> = { five_hour: "5-hour limit", seven_day: "weekly limit", seven_day_opus: "weekly Opus limit", seven_day_sonnet: "weekly Sonnet limit" };

/** The CLI's answer in the app's words, or null when it has no plan limits (signed in with an API key, say). */
export function readPlanUsage(answer: any): PlanUsage | null {
  const r = answer?.rate_limits;
  if (!r || answer.rate_limits_available === false) return null;
  const limits: UsageLimit[] = [];
  if (Array.isArray(r.limits) && r.limits.length) {
    for (const l of r.limits) {
      const percent = Number(l?.percent);
      if (!Number.isFinite(percent)) continue;
      const scope = String(l.scope?.model?.display_name || "");
      const name = l.kind === "session" ? "5-hour limit" : scope ? `weekly ${scope} limit` : l.group === "weekly" ? "weekly limit" : "plan limit";
      limits.push({ name, percent, resetsAt: minute(l.resets_at), ...(scope ? { model: scope.toLowerCase() } : {}), ...(l.severity && l.severity !== "normal" ? { near: true } : {}) });
    }
  } else {
    for (const [key, name] of Object.entries(NAMES)) {
      const percent = r[key]?.utilization;
      if (typeof percent !== "number") continue;
      const model = /_(opus|sonnet)$/.exec(key)?.[1];
      limits.push({ name, percent, resetsAt: minute(r[key].resets_at), ...(model ? { model } : {}) });
    }
  }
  if (!limits.length) return null;
  const e = r.extra_usage, unit = 10 ** (Number(e?.decimal_places) || 0);
  const extra = e?.is_enabled && Number(e.monthly_limit) > 0
    ? { used: Number(e.used_credits) / unit || 0, cap: Number(e.monthly_limit) / unit, currency: String(e.currency || "USD"), reached: !!e.spend_limit_reached } : undefined;
  return { plan: String(answer.subscription_type || ""), limits, ...(extra ? { extra } : {}) };
}

function ask(): Promise<PlanUsage | null> {
  return new Promise((resolve) => {
    const bin = findClaude();
    if (!bin) return resolve(null);
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; // the plan's limits, not an API key's
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--tools", ""],
        { cwd: os.tmpdir(), windowsHide: true, env });
    } catch { return resolve(null); }
    let buf = "";
    const done = (u: PlanUsage | null) => { clearTimeout(timer); child.kill(); resolve(u); };
    const timer = setTimeout(() => done(null), 15_000);
    child.stdout!.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === "control_response") return done(readPlanUsage(ev.response?.response));
        } catch { /* not JSON */ }
      }
    });
    child.on("error", () => done(null));
    child.on("close", () => done(null));
    child.stdin!.on("error", () => {});
    // (The input stays open until the answer: closing it first ends the CLI before it has replied.)
    child.stdin!.write(`${JSON.stringify({ type: "control_request", request_id: "usage", request: { subtype: "get_usage" } })}\n`);
  });
}

let last: { at: number; usage: Promise<PlanUsage | null> } | null = null;

/** The plan's limits now (asked at most once a minute); null when they can't be had. */
export function claudePlanUsage(): Promise<PlanUsage | null> {
  if (!last || Date.now() - last.at > 60_000) last = { at: Date.now(), usage: ask() };
  return last.usage;
}

/** A request has just used some of the limits: ask again next time. */
export const forgetPlanUsage = () => { last = null; };
