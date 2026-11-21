// Planning request to Ollama's /api/chat, with the output forced to the itinerary schema.
import { lines } from "../util/http";
import type { LocalOutput } from "./local-output";
import { LOCAL_SCHEMA } from "./schema";
import type { OnEvent, Trip } from "./types";

interface OllamaPlan { base: string; model: string; prompt: string; trip: Trip; abort: AbortSignal; onEvent: OnEvent; output: LocalOutput }

export async function planWithOllama({ base, model, prompt, trip, abort, onEvent, output }: OllamaPlan) {
  let canThink = false;
  try {
    const info: any = await (await fetch(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model }) })).json();
    canThink = (info.capabilities || []).includes("thinking");
  } catch { /* older Ollama */ }
  // The context window must hold the prompt, the thinking and the whole JSON answer (about 1k tokens per day).
  // Ollama's default is only a few thousand tokens, and running out ends the answer early.
  const tripDays = trip.revise?.itinerary?.days?.length || trip.stays.reduce((n, s) => n + (Number(s.nights) || 0), 0) + 1;
  const needed = Math.ceil(prompt.length / 3) + tripDays * 1000 + 4000 + (canThink ? 16000 : 0);
  const numCtx = Math.min(Number(process.env.OLLAMA_NUM_CTX) || 65536, Math.ceil(needed / 4096) * 4096);
  onEvent({
    type: "prompt", label: "Planning prompt",
    info: `Sent to Ollama /api/chat · model: ${model} · context ${numCtx.toLocaleString()} tokens · temperature 0.4 · thinking ${canThink ? "on" : "off"} · `
      + "output forced to the JSON schema at the end of the prompt (Ollama's format option). Ollama adds the model's own system prompt, if it has one.",
    text: prompt,
  });
  const chat = (think: boolean) => fetch(`${base}/api/chat`, {
    method: "POST", signal: abort,
    body: JSON.stringify({
      model, stream: true, format: LOCAL_SCHEMA, ...(think ? { think: true } : {}),
      messages: [{ role: "user", content: prompt }], options: { num_ctx: numCtx, temperature: 0.4 },
    }),
  });
  // Some thinking models only take a thinking level, not on/off; then run without it rather than fail.
  let res = await chat(canThink);
  if (!res.ok && canThink) res = await chat(false);
  if (!res.ok) throw new Error(`Ollama: ${(await res.text()).slice(0, 500)}`);
  const tokensBefore = output.out.tokens;
  for await (const line of lines(res.body)) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    if (ev.error) throw new Error(`Ollama: ${ev.error}`);
    if (ev.message?.thinking || ev.message?.content) output.tick();
    if (ev.message?.thinking) output.onThinking(ev.message.thinking);
    if (ev.message?.content) output.onContent(ev.message.content);
    // The last line has Ollama's exact count and generation speed.
    if (ev.done && ev.eval_count) output.setExact(tokensBefore + ev.eval_count, ev.eval_duration ? ev.eval_count / (ev.eval_duration / 1e9) : undefined);
    if (ev.done && ev.done_reason === "length") {
      throw new Error(`${model} ran out of context (${numCtx.toLocaleString()} tokens) ${output.out.content.trim() ? "before finishing the itinerary" : "while still thinking, before writing anything"}. `
        + "Try fewer saved places or a shorter trip, or raise the limit by setting OLLAMA_NUM_CTX (e.g. 98304) before starting the planner.");
    }
  }
}
