// Planning request to Ollama's /api/chat, with the output forced to the itinerary schema.
import { lines } from "../util/http";
import type { LocalOutput } from "./local-output";
import { keepAlive, readSettings } from "../settings";
import { addDays } from "../config";
import { jsonLoopGuard, loopGuard } from "./loop-guard";
import { partialDays } from "./output";
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
  const tripDays = trip.redoDay ? 1 : trip.edit ? trip.edit.days.length : trip.fix ? new Set(trip.fix.problems.map((p) => p.day)).size : trip.revise?.itinerary?.days?.length || trip.stays.reduce((n, s) => n + (Number(s.nights) || 0), 0) + 1;
  const promptTokens = Math.ceil(prompt.length / 3);
  // Settings → Local models can fix the context size; otherwise up to OLLAMA_NUM_CTX (or 128k), as much as the trip needs.
  const fixed = readSettings().numCtx, t = readSettings().tune;
  const cap = fixed ? Math.min(fixed, modelMax || fixed) : Math.min(Number(process.env.OLLAMA_NUM_CTX) || 131072, modelMax || 131072);
  const needed = promptTokens + tripDays * 1000 + 4000 + (canThink ? 16000 : 0);
  const firstCtx = fixed ? cap : Math.min(cap, roundUp(needed));

  const run = async (numCtx: number, think: boolean, label: string, text = prompt): Promise<"ok" | "length" | "loop"> => {
    // Stopped by the travelers (abort) or by us when the model starts repeating itself (stop).
    const stop = new AbortController(), signal = AbortSignal.any([abort, stop.signal]);
    // Loops happen in the thinking; the itinerary JSON gets only the much stricter check.
    const thinkLoop = loopGuard(), jsonLoop = jsonLoopGuard();
    onEvent({
      type: "prompt", label,
      info: `Sent to Ollama /api/chat · model: ${model} · context window ${numCtx.toLocaleString()} tokens (the prompt about ${(Math.round(Math.ceil(text.length / 3) / 100) * 100).toLocaleString()}, the rest room for thinking and the plan) · temperature ${t.temperature} · thinking ${think ? "on" : "off"} · `
        + "output forced to the JSON schema at the end of the prompt (Ollama's format option). Ollama adds the model's own system prompt, if it has one.",
      text,
    });
    const chat = (withThink: boolean) => fetch(`${base}/api/chat`, {
      method: "POST", signal,
      body: JSON.stringify({
        model, stream: true, format: LOCAL_SCHEMA, ...(withThink ? { think: true } : canThink ? { think: false } : {}),
        messages: [{ role: "user", content: text }], options: { num_ctx: numCtx, temperature: t.temperature }, keep_alive: keepAlive(t.keepAlive),
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
        const piece = ev.message?.thinking || ev.message?.content || "";
        if (piece) output.tick();
        if (ev.message?.thinking) output.onThinking(ev.message.thinking);
        if (ev.message?.content) output.onContent(ev.message.content);
        if ((ev.message?.thinking && thinkLoop(ev.message.thinking)) || (ev.message?.content && jsonLoop(ev.message.content))) { stop.abort(); return "loop"; }
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

  const first = await run(firstCtx, canThink && t.thinking === "on", "Planning prompt");
  if (first === "ok") return;
  // Days already written: keep them, and have it write only the rest (the same prompt with that added at the end, so
  // Ollama can reuse what it read of the prompt), then join the two.
  const done = partialDays(output.out.content);
  // Every day written (only the tips and such were cut off): that's the plan.
  if (done && done.days.length >= tripDays && !trip.redoDay && !trip.edit && !trip.fix) {
    output.out.content = JSON.stringify({ ...done.head, days: done.days, totalEstimatedCost: done.days.reduce((n: number, d: any) => n + (Number(d.estimatedCost) || 0), 0) });
    return;
  }
  if (done && done.days.length < tripDays && !trip.redoDay && !trip.edit && !trip.fix) {
    const last = String(done.days.at(-1)?.date || ""), lastStay = trip.stays.at(-1);
    const end = lastStay?.start ? addDays(lastStay.start, Number(lastStay.nights) || 0) : "";
    onEvent({ type: "status", text: `${model} ${first === "loop" ? "got stuck" : "ran out of room"} after ${done.days.length} of ${tripDays} days; keeping those and writing the rest…` });
    const rest = `${prompt}

## Already written (keep as is)
The first ${done.days.length} day(s) of the itinerary are done:
${done.days.map((d) => `${d.date} ${d.city}: ${(d.items || []).map((x: any) => x.place).join("; ")}`).join("\n")}

## Write only the remaining days
Continue the itinerary from the day after ${last}${end ? ` to the end of the trip (${end})` : ""}. This overrides the rule about one entry per calendar day: return the itinerary with "days" containing only the remaining days, each complete. Don't repeat places from the days already written. Give "tips", "holidaysAndEvents" and "unused" for the whole trip as usual; "summary" and "planningNotes" can be short.`;
    output.restart(done.days.length);
    const second = await run(Math.min(cap, Math.max(firstCtx, roundUp(Math.ceil(rest.length / 3) + (tripDays - done.days.length) * 1000 + 4000))), false, "Planning prompt (the remaining days)", rest);
    if (second === "ok") {
      let more: any = null;
      try { more = JSON.parse(output.out.content.slice(output.out.content.indexOf("{"), output.out.content.lastIndexOf("}") + 1)); } catch { /* checked below */ }
      if (more && Array.isArray(more.days)) {
        const seen = new Set(done.days.map((d) => d.date));
        const days = [...done.days, ...more.days.filter((d: any) => !seen.has(d.date))];
        const merged = { ...done.head, ...more, summary: done.head.summary || more.summary, planningNotes: [done.head.planningNotes, more.planningNotes && `**The remaining days** (the model stopped after ${done.days.length} days and was asked for the rest)\n\n${more.planningNotes}`].filter(Boolean).join("\n\n"), days,
          totalEstimatedCost: days.reduce((n: number, d: any) => n + (Number(d.estimatedCost) || 0), 0) };
        output.out.content = JSON.stringify(merged);
        onEvent({ type: "progress", days: days.length });
        return;
      }
    }
    throw new Error(`${model} stopped after ${done.days.length} of ${tripDays} days and couldn't finish the rest. Try again, or a model with a longer context.`);
  }
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
