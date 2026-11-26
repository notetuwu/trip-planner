// Plans with OpenAI or OpenRouter models through the Responses API (pay per token with your own key). The model
// searches the web with the provider's own search tool and answers with the itinerary as JSON (planning notes in a
// field), constrained to the schema where the model supports it.
import type { CloudProvider, RunResult } from "../../shared/types";
import { getKey, PROVIDERS } from "../keys";
import { lines } from "../util/http";
import { parseCloudId } from "./cloud-models";
import { localOutput } from "./local-output";
import { normalizeItinerary, parseJsonLoose } from "./output";
import { buildPrompt } from "./prompt";
import { LOCAL_SCHEMA } from "./schema";
import type { Runner } from "./types";

// OPENAI_BASE_URL / OPENROUTER_BASE_URL point elsewhere, e.g. a proxy (or a mock server in tests).
export const BASE: Partial<Record<CloudProvider, string>> = {
  openai: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  openrouter: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
};
const SEARCH_TOOL: Partial<Record<CloudProvider, object>> = {
  openai: { type: "web_search" },
  openrouter: { type: "openrouter:web_search", parameters: { max_results: 5 } },
};

export const runResponses: Runner = async (trip, places, onEvent, abort): Promise<RunResult> => {
  const { provider, model } = parseCloudId(trip.model);
  const key = getKey(provider), base = BASE[provider];
  if (!base) throw new Error(`Unknown provider ${provider}`);
  if (!key) throw new Error(`No ${PROVIDERS[provider].name} API key. Add one under 🔑 API keys, or set ${PROVIDERS[provider].env}.`);
  const t0 = Date.now();
  const output = localOutput(onEvent);
  const sources = new Set<string>();
  let searches = 0, costUsd: number | undefined;

  const request = (withSchema: boolean) => {
    const prompt = buildPrompt(trip, places, { notes: "json", webTools: true, schema: !withSchema });
    onEvent({
      type: "prompt", label: withSchema ? "Prompt" : "Prompt (retry without enforced schema)",
      info: `Sent to ${PROVIDERS[provider].name} (Responses API) · model: ${model}${trip.research ? " · tool: web search" : ""} · `
        + `${withSchema ? "answer constrained to the itinerary JSON schema" : "schema in the prompt"} · billed to your API key.`,
      text: prompt,
    });
    return fetch(`${base}/responses`, {
      method: "POST", signal: abort,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, input: prompt, stream: true,
        ...(trip.research ? { tools: [SEARCH_TOOL[provider]] } : {}),
        ...(withSchema ? { text: { format: { type: "json_schema", name: "itinerary", schema: LOCAL_SCHEMA, strict: false } } } : {}),
      }),
    });
  };

  let res = await request(true);
  if (res.status === 400 || res.status === 422) res = await request(false);
  if (!res.ok) throw new Error(`${PROVIDERS[provider].name}: ${(await res.text()).slice(0, 500)}`);

  for await (const line of lines(res.body)) {
    if (!line.startsWith("data:")) continue;
    let ev: any;
    try { ev = JSON.parse(line.slice(5)); } catch { continue; }
    const t: string = ev.type || "";
    if (t === "response.output_text.delta") { output.tick(); output.onContent(ev.delta || ""); }
    else if (/^response\.reasoning(_summary)?_text\.delta$/.test(t)) { output.tick(); output.onThinking(ev.delta || ""); }
    else if (t === "response.output_text.annotation.added" && ev.annotation?.url) sources.add(ev.annotation.url);
    else if (t === "response.output_item.done" && ev.item?.type === "web_search_call") {
      const a = ev.item.action || {};
      searches++;
      for (const q of [a.query, ...(a.queries || [])].filter(Boolean)) onEvent({ type: "search", query: q });
      if (a.url) onEvent({ type: "fetch", url: a.url });
    } else if (t === "response.completed") {
      const u = ev.response?.usage || {};
      if (u.output_tokens) output.setExact(u.output_tokens);
      if (typeof u.cost === "number") costUsd = u.cost; // OpenRouter reports what the call cost
    } else if (t === "response.failed" || t === "error") {
      throw new Error(ev.response?.error?.message || ev.error?.message || ev.message || "The model failed");
    } else if (t === "response.incomplete") {
      throw new Error(`${model} stopped early (${ev.response?.incomplete_details?.reason || "incomplete"}) before finishing the itinerary.`);
    }
  }

  let parsed;
  try { parsed = parseJsonLoose(output.out.content); } catch { /* reported below */ }
  const itinerary = normalizeItinerary(parsed, Number(trip.travelers) || 1, trip.people);
  if (!itinerary) throw new Error(`${model} didn't return a usable itinerary.${output.out.content ? `\n\nIts answer began:\n${output.out.content.slice(0, 600)}` : ""}`);
  const reasoning = String(itinerary.planningNotes || "").trim();
  delete itinerary.planningNotes;
  if (!itinerary.sources?.length && sources.size) itinerary.sources = [...sources];
  return {
    itinerary, reasoning, thinking: output.out.thinking.trim().slice(0, 20000), durationMs: Date.now() - t0,
    tokens: output.out.tokens, costUsd, engine: `${model} via ${PROVIDERS[provider].name}`, billing: "api", searches,
  };
};
