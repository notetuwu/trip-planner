// Planning request to Ollama's /api/chat, with the output forced to the itinerary schema.
import { lines } from "../util/http";
import type { LocalOutput } from "./local-output";
import { readSettings } from "../settings";
import { loopGuard } from "./loop-guard";
import { LOCAL_SCHEMA } from "./schema";
import type { OnEvent, Trip } from "./types";

interface OllamaPlan { base: string; model: string; prompt: string; trip: Trip; abort: AbortSignal; onEvent: OnEvent; output: LocalOutput }

const roundUp = (n: number) => Math.ceil(n / 4096) * 4096;

export async function planWithOllama({ base, model, prompt, trip, abort, onEvent, output }: OllamaPlan) {
  let canThink = false, modelMax = 0;
  try {
    const info: any = await (await fetch(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model }) })).json();
    canThink = (info.capabilities || []).includes("thinking");
    // The longest context the model was trained for (e.g. "qwen35.context_length": 262144).
    modelMax = Number(Object.entries(info.model_info || {}).find(([k]) => k.endsWith(".context_length"))?.[1]) || 0;
  } catch { /* older Ollama */ }
  // The context window must hold the prompt, the thinking and the whole JSON answer (about 1k tokens per day).
  // Ollama only reserves what's asked for (more costs GPU memory), so ask for about what's needed, within the model's limit.
  const tripDays = trip.redoDay ? 1 : trip.fix ? new Set(trip.fix.problems.map((p) => p.day)).size : trip.revise?.itinerary?.days?.length || trip.stays.reduce((n, s) => n + (Number(s.nights) || 0), 0) + 1;
  const promptTokens = Math.ceil(prompt.length / 3);
  // Settings → Local models can fix the context size; otherwise up to OLLAMA_NUM_CTX (or 128k), as much as the trip needs.
  const fixed = readSettings().numCtx;
  const cap = fixed ? Math.min(fixed, modelMax || fixed) : Math.min(Number(process.env.OLLAMA_NUM_CTX) || 131072, modelMax || 131072);
  const needed = promptTokens + tripDays * 1000 + 4000 + (canThink ? 16000 : 0);
  const firstCtx = fixed ? cap : Math.min(cap, roundUp(needed));

  const run = async (numCtx: number, think: boolean, label: string): Promise<"ok" | "length" | "loop"> => {
    // Stopped by the travelers (abort) or by us when the model starts repeating itself (stop).
    const stop = new AbortController(), signal = AbortSignal.any([abort, stop.signal]);
    const looping = loopGuard();
    onEvent({
      type: "prompt", label,
      info: `Sent to Ollama /api/chat · model: ${model} · context ${numCtx.toLocaleString()} tokens · temperature 0.4 · thinking ${think ? "on" : "off"} · `
        + "output forced to the JSON schema at the end of the prompt (Ollama's format option). Ollama adds the model's own system prompt, if it has one.",
      text: prompt,
    });
    const chat = (withThink: boolean) => fetch(`${base}/api/chat`, {
      method: "POST", signal,
      body: JSON.stringify({
        model, stream: true, format: LOCAL_SCHEMA, ...(withThink ? { think: true } : canThink ? { think: false } : {}),
        messages: [{ role: "user", content: prompt }], options: { num_ctx: numCtx, temperature: 0.4 },
      }),
    });
    // Some thinking models only take a thinking level, not on/off; then run without it rather than fail.
    let res = await chat(think);
    if (!res.ok && think) res = await chat(false);
    if (!res.ok) throw new Error(`Ollama: ${(await res.text()).slice(0, 500)}`);
    const tokensBefore = output.out.tokens;
    try {
      for await (const line of lines(res.body)) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(`Ollama: ${ev.error}`);
        const text = ev.message?.thinking || ev.message?.content || "";
        if (text) output.tick();
        if (ev.message?.thinking) output.onThinking(ev.message.thinking);
        if (ev.message?.content) output.onContent(ev.message.content);
        if (text && looping(text)) { stop.abort(); return "loop"; }
        // The last line has Ollama's exact count and generation speed.
        if (ev.done && ev.eval_count) output.setExact(tokensBefore + ev.eval_count, ev.eval_duration ? ev.eval_count / (ev.eval_duration / 1e9) : undefined);
        if (ev.done) return ev.done_reason === "length" ? "length" : "ok";
      }
    } catch (e) {
      if (stop.signal.aborted && !abort.aborted) return "loop";
      throw e;
    }
    return "ok";
  };

  const first = await run(firstCtx, canThink, "Planning prompt");
  if (first === "ok") return;
  // Out of room (usually from long thinking) or stuck repeating itself: once more without the thinking, with twice
  // the room if it ran out.
  const when = output.out.content.trim() ? "before finishing the itinerary" : "while still thinking, before writing anything";
  const secondCtx = first === "length" ? Math.min(cap, roundUp(Math.max(firstCtx * 2, needed))) : firstCtx;
  if (first === "length" && secondCtx <= firstCtx && !canThink) throw outOfRoom(model, firstCtx, when);
  onEvent({ type: "status", text: first === "loop"
    ? `${model} got stuck repeating itself ${when}; trying again without the long thinking…`
    : `${model} ran out of room (${firstCtx.toLocaleString()} tokens) ${when}; trying again with ${secondCtx.toLocaleString()} tokens${canThink ? " and without the long thinking" : ""}…` });
  output.restart();
  const second = await run(secondCtx, false, "Planning prompt (retry)");
  if (second === "ok") return;
  if (second === "loop") throw new Error(`${model} kept repeating itself instead of writing the plan, even without thinking. Try again, or a different model.`);
  throw outOfRoom(model, secondCtx, output.out.content.trim() ? "before finishing the itinerary" : "before writing anything");
}

const outOfRoom = (model: string, ctx: number, when: string) => new Error(
  `${model} ran out of context (${ctx.toLocaleString()} tokens) ${when}, even after a retry with more room. `
  + "Try fewer saved places or a shorter trip, or a model with a longer context. (You can raise the planner's limit with OLLAMA_NUM_CTX, e.g. 196608, before starting it; more context needs more GPU memory.)");
