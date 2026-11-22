// Planning request to an OpenAI-compatible server (LM Studio, llama.cpp, vLLM…). Asks for schema-constrained JSON;
// if the server rejects that, retries relying on the schema in the prompt alone.
import { tune } from "../settings";
import { lines } from "../util/http";
import { serverName } from "./local-models";
import type { LocalOutput } from "./local-output";
import { LOCAL_SCHEMA } from "./schema";
import type { OnEvent } from "./types";

interface OpenAiPlan { base: string; model: string; prompt: string; abort: AbortSignal; onEvent: OnEvent; output: LocalOutput }

export async function planWithOpenAi({ base, model, prompt, abort, onEvent, output }: OpenAiPlan) {
  const request = (withSchema: boolean) => fetch(`${base}/v1/chat/completions`, {
    method: "POST", signal: abort, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: true, temperature: tune().temperature, messages: [{ role: "user", content: prompt }],
      ...(withSchema ? { response_format: { type: "json_schema", json_schema: { name: "itinerary", schema: LOCAL_SCHEMA } } } : {}),
    }),
  });
  onEvent({
    type: "prompt", label: "Planning prompt",
    info: `Sent to ${serverName("openai", base)} (/v1/chat/completions) · model: ${model} · temperature ${tune().temperature} · `
      + "output asked for as JSON matching the schema at the end of the prompt (enforced if the server supports it).",
    text: prompt,
  });
  let res = await request(true);
  if (res.status === 400 || res.status === 422) res = await request(false);
  if (!res.ok) throw new Error(`${base}: ${(await res.text()).slice(0, 500)}`);
  for await (const line of lines(res.body)) {
    const data = line.replace(/^data:\s*/, "").trim();
    if (!data || data === "[DONE]" || !line.startsWith("data:")) continue;
    const delta = JSON.parse(data).choices?.[0]?.delta || {};
    const think = delta.reasoning_content || delta.reasoning;
    if (think || delta.content) output.tick();
    if (think) output.onThinking(think);
    if (delta.content) output.onContent(delta.content);
  }
}
