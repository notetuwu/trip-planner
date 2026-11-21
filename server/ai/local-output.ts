// Collects a local model's streamed answer: thinking, the JSON itinerary, planning notes and token counts,
// and reports progress to the browser as it arrives.
import { daysWritten, partialNotes, tokenMeter } from "./output";
import type { OnEvent } from "./types";

export function localOutput(onEvent: OnEvent) {
  const out = { content: "", thinking: "", tokens: 0, perSec: undefined as number | undefined };
  let raw = "", inlineThought = 0, days = 0, lastNotes = "";
  // Local servers stream one token per chunk, so counting chunks counts tokens.
  const meter = tokenMeter(onEvent, false);

  const onThinking = (piece: string) => { out.thinking += piece; onEvent({ type: "thought", text: piece }); };

  // Some reasoning models (e.g. DeepSeek-R1 on llama.cpp) put their thinking inline as <think>…</think> before the answer.
  const onContent = (piece: string) => {
    raw += piece;
    const m = raw.match(/^\s*<think>([\s\S]*?)(<\/think>|$)([\s\S]*)$/);
    if (m) {
      if (m[1].length > inlineThought) { onThinking(m[1].slice(inlineThought)); inlineThought = m[1].length; }
      if (!m[2]) return;
      piece = m[3].slice(out.content.length);
    }
    out.content += piece;
    const notes = partialNotes(out.content);
    if (notes != null && notes !== lastNotes) { lastNotes = notes; onEvent({ type: "notes", text: notes }); }
    const n = daysWritten(out.content);
    if (n !== days) { days = n; onEvent({ type: "progress", days }); }
  };

  const tick = () => meter(++out.tokens);
  /** Exact totals from the server (Ollama reports them at the end). */
  const setExact = (tokens: number, perSec?: number) => { out.tokens = tokens; out.perSec = perSec; meter(tokens, { force: true, perSec }); };

  return { out, onThinking, onContent, tick, setExact };
}

export type LocalOutput = ReturnType<typeof localOutput>;
