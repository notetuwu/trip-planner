// Research with a model of its own (Settings → Search & places): it looks things up first, and the planning model gets
// its findings instead of searching itself. Only a Gemini or a local model can do it (they take the planner's tools).
import type { Place } from "../../shared/types";
import { geminiResearch } from "../ai/gemini";
import { parseModelId } from "../ai/local-models";
import { localOutput } from "../ai/local-output";
import { ensureOllama } from "../ai/ollama-start";
import type { OnEvent, Trip } from "../ai/types";
import { localResearch } from "./research";

/** The findings and pages read; `model` is the one that did the research. Throws what went wrong. */
export async function researchWith(id: string, trip: Trip, places: Place[], onEvent: OnEvent, abort: AbortSignal) {
  let searches = 0;
  const count: OnEvent = (ev) => { if (ev.type === "search") searches++; onEvent(ev); };
  // The research's own writing isn't the plan's, so none of it counts as the plan's tokens or thinking.
  const quiet = localOutput(() => {});
  if (id.startsWith("api|gemini|")) return { ...await geminiResearch(id, trip, places, count, abort, quiet), searches };
  const { kind, base, model } = parseModelId(id);
  if (kind === "ollama" && !(await ensureOllama())) throw new Error("Ollama isn't running and couldn't be started");
  const found = await localResearch({ kind, base, model, trip, places, onEvent: count, abort, onThinking: () => {}, tick: () => {} });
  return { ...found, model, searches };
}
