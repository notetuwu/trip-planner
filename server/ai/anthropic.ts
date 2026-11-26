// Plans with Claude through the Anthropic API (pay per token with your own key). Claude searches the web with the
// API's own web search and fetch tools, writes its planning notes as text, then hands over the itinerary by calling
// a tool whose input schema is the itinerary schema.
import { tune } from "../settings";
import Anthropic from "@anthropic-ai/sdk";
import type { RunResult } from "../../shared/types";
import { getKey } from "../keys";
import { claudeStreamHandler } from "./claude-stream";
import { anthropicMaxTokens, parseCloudId } from "./cloud-models";
import { normalizeItinerary, parseJsonLoose } from "./output";
import { type ClaudeUsage, claudeCostUsd } from "./prices";
import { buildPrompt } from "./prompt";
import { watchedFetch } from "./usage-notices";
import { ITINERARY_SCHEMA } from "./schema";
import type { Runner } from "./types";

const OUTPUT_TOOL = "submit_itinerary";

// Newer models get adaptive thinking, effort and the web tools with dynamic filtering; older ones the basic setup.
const MODERN = /fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5/;
const DYNAMIC_WEB = /fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6/;
// If a model's safety check declines the request, the API retries it on a fallback model instead of failing.
const FALLBACK = /fable|mythos|opus-5|sonnet-5-5/;

function tools(model: string, research: boolean): any[] {
  const out: any[] = [{
    name: OUTPUT_TOOL, description: "Submit the finished itinerary. Call this once, with the complete itinerary.",
    input_schema: ITINERARY_SCHEMA, eager_input_streaming: true,
  }];
  if (research) {
    const dynamic = DYNAMIC_WEB.test(model);
    out.push(
      { type: dynamic ? "web_search_20260209" : "web_search_20250305", name: "web_search", max_uses: tune().lookups },
      { type: dynamic ? "web_fetch_20260209" : "web_fetch_20250910", name: "web_fetch", max_uses: Math.max(3, Math.round(tune().lookups * 0.6)), max_content_tokens: 20000 },
    );
  }
  return out;
}

export const runAnthropic: Runner = async (trip, places, onEvent, abort): Promise<RunResult> => {
  const apiKey = getKey("anthropic");
  if (!apiKey) throw new Error("No Anthropic API key. Add one under Settings → AI models, or set ANTHROPIC_API_KEY.");
  const { model } = parseCloudId(trip.model);
  const client = new Anthropic({ apiKey, fetch: watchedFetch("anthropic") });
  const t0 = Date.now();
  const prompt = buildPrompt(trip, places, { webTools: true, outputTool: OUTPUT_TOOL });
  onEvent({
    type: "prompt", label: "Prompt",
    info: `Sent to the Anthropic API · model: ${model} · tools: ${OUTPUT_TOOL}${trip.research ? ", web_search, web_fetch" : ""} · billed to your API key.`,
    text: prompt,
  });

  const modern = MODERN.test(model);
  const params: any = {
    model, max_tokens: anthropicMaxTokens.get(model) || 64000, tools: tools(model, !!trip.research),
    ...(modern ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } } : {}),
    ...(FALLBACK.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  };
  const messages: any[] = [{ role: "user", content: prompt }];
  const stream = claudeStreamHandler(onEvent, OUTPUT_TOOL);
  const usage: ClaudeUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, searches: 0 };
  let itinerary: any = null, nudged = false;

  // A turn can pause after many server-side searches (pause_turn); send it back and the API carries on.
  for (let turn = 0; turn < 8 && !itinerary; turn++) {
    const s = client.beta.messages.stream({ ...params, messages }, { signal: abort });
    for await (const ev of s) stream.event(ev);
    const msg: any = await s.finalMessage();
    const u = msg.usage || {};
    usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0;
    usage.cacheWrite += u.cache_creation_input_tokens || 0; usage.cacheRead += u.cache_read_input_tokens || 0;
    usage.searches += u.server_tool_use?.web_search_requests || 0;

    if (msg.stop_reason === "refusal") throw new Error(`Claude declined to plan this${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : "."}`);
    const call = msg.content.find((b: any) => b.type === "tool_use" && b.name === OUTPUT_TOOL);
    if (call) { itinerary = call.input; break; }
    if (msg.stop_reason === "max_tokens") throw new Error(`${model} ran out of output tokens before finishing the itinerary. Try fewer days per plan or a model with a larger output limit.`);
    messages.push({ role: "assistant", content: msg.content });
    if (msg.stop_reason === "pause_turn") continue;
    // It answered in text instead of calling the tool: take JSON if it wrote some, else ask once more.
    const text = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    try { itinerary = parseJsonLoose(text); } catch { /* not JSON */ }
    if (itinerary || nudged) break;
    nudged = true;
    messages.push({ role: "user", content: `Now call the ${OUTPUT_TOOL} tool with the complete itinerary.` });
  }

  const normalized = normalizeItinerary(itinerary, Number(trip.travelers) || 1, trip.people);
  if (!normalized) throw new Error(`${model} didn't return an itinerary.`);
  return {
    itinerary: normalized, reasoning: stream.state.reasoning.trim(), thinking: stream.state.thinking.trim().slice(0, 20000),
    costUsd: claudeCostUsd(model, usage), durationMs: Date.now() - t0, tokens: usage.output,
    engine: `${model} via the Anthropic API`, billing: "api", searches: usage.searches,
  };
};
