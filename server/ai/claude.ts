// Plans with Claude by running `claude -p` (Claude Code CLI) with streaming JSON output and the itinerary schema.
import { spawn } from "node:child_process";
import os from "node:os";
import type { RunResult } from "../../shared/types";
import { TIMEOUT_MS } from "../config";
import { findClaude } from "./claude-bin";
import { claudeStreamHandler } from "./claude-stream";
import { buildPrompt } from "./prompt";
import { ITINERARY_SCHEMA } from "./schema";
import type { Runner } from "./types";

export const runClaude: Runner = (trip, places, onEvent, abort) => new Promise<RunResult>((resolve, reject) => {
  const bin = findClaude();
  if (!bin) return reject(new Error("Could not find the claude CLI. Set CLAUDE_BIN to its path."));

  // With research on, Claude may search and read web pages (and nothing else); both are pre-approved since nobody can answer a prompt.
  const tools = trip.research ? ["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"] : ["--tools", ""];
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--json-schema", JSON.stringify(ITINERARY_SCHEMA), ...tools, "--no-session-persistence",
  ];
  if (trip.model && trip.model !== "default") args.push("--model", trip.model);

  // Drop any API key so the CLI always uses the claude.ai subscription login, never pay-per-token API billing.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn(bin, args, { cwd: os.tmpdir(), windowsHide: true, env });
  const stream = claudeStreamHandler(onEvent);
  let buf = "", stderr = "";
  const timer = setTimeout(() => { child.kill(); reject(new Error("Claude timed out")); }, TIMEOUT_MS);
  abort.addEventListener("abort", () => { child.kill(); reject(new Error("Cancelled")); });

  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { stream.handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on("data", (d) => { stderr += d; });
  child.on("error", (e) => { clearTimeout(timer); reject(e); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (buf.trim()) stream.handle(buf);
    const { result, reasoning, doneTokens } = stream.state;
    if (!result) return reject(new Error(`claude exited ${code}: ${stderr || "no result"}`.slice(0, 2000)));
    if (result.is_error) return reject(new Error(result.result || "Claude returned an error"));
    let itinerary = result.structured_output;
    if (!itinerary && typeof result.result === "string") {
      const m = result.result.match(/\{[\s\S]*\}/);
      try { itinerary = m && JSON.parse(m[0]); } catch { /* not JSON */ }
    }
    if (!itinerary) return reject(new Error("Claude did not return an itinerary:\n" + String(result.result).slice(0, 2000)));
    // The model that wrote the most is the one that planned (Claude Code also uses a small model for side tasks).
    const usage = Object.entries<any>(result.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0))[0];
    const [model, stats] = usage || ["Claude", {}];
    resolve({
      itinerary, reasoning: reasoning.trim(), costUsd: result.total_cost_usd, durationMs: result.duration_ms,
      engine: `${model} via Claude Code`, tokens: stats.outputTokens || doneTokens,
    });
  });

  const prompt = buildPrompt(trip, places);
  onEvent({
    type: "prompt", label: "Prompt",
    info: `Sent to the Claude Code CLI (claude -p) · model: ${trip.model && trip.model !== "default" ? trip.model : "CLI default"} · tools: ${trip.research ? "WebSearch, WebFetch" : "none"} · `
      + "the itinerary comes back through a StructuredOutput tool forced to the itinerary JSON schema. Claude Code also adds its own system prompt, which isn't visible here.",
    text: prompt,
  });
  child.stdin.end(prompt);
});
