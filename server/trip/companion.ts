// The trip chat: questions about the trip on screen ("what's on Thursday?", "where can we eat near the castle?", "is
// two nights in Salzburg enough?"), answered by the selected model from what the page sends about the trip (stays,
// the itinerary, must-sees, the ideas notes) and the conversation so far. Plain text back, streamed as it's written.
import { askModel } from "../ai/ask";
import type { Report } from "../util/progress-stream";

export interface CompanionTurn { role: "me" | "ai"; text: string }
export interface CompanionRequest { model: string; question: string; context?: string; history?: CompanionTurn[]; today?: string }

const MAX_CONTEXT = 60_000, MAX_TURN = 4_000;
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export function companionPrompt(req: CompanionRequest) {
  const history = (Array.isArray(req.history) ? req.history : []).slice(-12)
    .map((t) => `${t.role === "me" ? "Traveler" : "You"}: ${clip(t.text, MAX_TURN)}`).join("\n\n");
  return `You are the travel companion for the trip below: a friendly, well-travelled local expert the travelers can ask anything about their trip, before or during it.

## The trip
${clip(req.context, MAX_CONTEXT) || "(Nothing planned yet: no stays or itinerary.)"}

## How to answer
- Answer from the trip above when the question is about it (dates, days, stops, stays, costs, bookings, their ideas notes). Say which day or stay you mean.
- For anything else (food, getting around, what's worth it, weather, customs, packing, alternatives) use what you know about the places; say when something is worth checking (opening hours, prices and timetables change).
- Be concrete and brief: a few sentences or a short list. Suggest a change to the plan when it helps, but don't rewrite the whole itinerary unless asked.
- Plain text with light Markdown only (**bold**, "- " bullets). No JSON, no tables.
- Answer in the language the traveler writes in.${req.today ? `\n- Today is ${clip(req.today, 20)}.` : ""}
${history ? `\n## The conversation so far\n${history}\n` : ""}
## The traveler asks
${clip(req.question, MAX_TURN)}`;
}

/** Strips what some models wrap answers in (a code fence, a leading "You:"). */
export const cleanAnswer = (text: string) =>
  text.trim().replace(/^```(?:\w+)?\n([\s\S]*?)\n```$/, "$1").replace(/^(You|Assistant|Companion):\s*/i, "").trim();

export async function askCompanion(req: CompanionRequest, report: Report, signal?: AbortSignal) {
  report({ type: "status", text: "Thinking…" });
  const answer = await askModel(req.model, companionPrompt(req), (n) => report({ type: "tokens", n }), {
    signal,
    nudge: "Answer the traveler's question right away, briefly.",
    // The answer so far goes out as it's written (as "reasoning", the channel the page already shows live).
    onText: (reply, thinking) => {
      if (reply.trim()) report({ type: "reasoning", text: cleanAnswer(reply) });
      else if (thinking) report({ type: "status", text: "Thinking…" });
    },
    onRetry: (message) => report({ type: "status", text: message }),
  });
  const text = cleanAnswer(answer);
  if (!text) throw new Error("The model didn't answer. Try again, or pick a different model.");
  return { answer: text };
}
