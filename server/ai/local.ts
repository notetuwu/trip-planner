// Plans with a local model: optional web research first, then the planning request, then a tidy-up of the answer.
import type { RunResult } from "../../shared/types";
import { errMsg, sleep } from "../config";
import { localResearch } from "../research/research";
import { parseModelId, serverName } from "./local-models";
import { planWithOllama } from "./local-ollama";
import { planWithOpenAi } from "./local-openai";
import { localOutput } from "./local-output";
import { normalizeItinerary, parseJsonLoose, addMissingMustSees } from "./output";
import { buildPrompt } from "./prompt";
import { planInSteps } from "./local-steps";
import { ensureOllama } from "./ollama-start";
import { tune } from "../settings";
import type { Runner } from "./types";

export const runLocal: Runner = async (trip, places, onEvent, abort): Promise<RunResult> => {
  // Ollama may have stopped since the models were listed (e.g. after the PC slept): start it again, or say so plainly.
  if (parseModelId(trip.model).kind === "ollama" && !(await ensureOllama())) throw new Error("Ollama isn't running and couldn't be started. Start Ollama, then generate again.");
  // Settings → Planning: a whole new plan step by step (re-planning a day, fixes and changes stay single requests).
  if (tune().localPlan === "steps" && !trip.redoDay && !trip.fix && !trip.edit && !trip.revise) return planInSteps(trip, places, onEvent, abort);
  const { kind, base, model } = parseModelId(trip.model);
  const t0 = Date.now();
  const output = localOutput(onEvent);
  const { out } = output;

  let research: { notes: string; urls: string[] } | null = null;
  if (trip.research) {
    try {
      research = await localResearch({ kind, base, model, trip, places, onEvent, abort, onThinking: output.onThinking, tick: output.tick });
      if (research.notes) onEvent({ type: "notes", text: `**Research findings**\n\n${research.notes}` });
    } catch (e) {
      // Research is a bonus: if it fails (no tool support, odd server reply), plan without it rather than fail the run.
      if (abort.aborted) throw e;
      const why = errMsg(e) === "NO_TOOLS" ? `${model} can't use tools` : `Research failed (${errMsg(e).slice(0, 120)})`;
      onEvent({ type: "status", text: `${why}, so it plans without web research…` });
      onEvent({ type: "notes", text: `**No web research:** ${why}.` });
      await sleep(1500); // leave the message readable for a moment
    }
    onEvent({ type: "status", text: "Planning the itinerary…" });
  }

  const prompt = buildPrompt({ ...trip, researchNotes: research?.notes }, places, { notes: "json", schema: true, compact: true });
  // Local servers send nothing while they read the prompt, which on a big trip can take minutes; say so until the first token.
  onEvent({ type: "status", text: `Reading the prompt (about ${(Math.round(prompt.length / 4 / 1000) || 1).toLocaleString()}k tokens)… on big trips this can take a few minutes` });
  const tick = output.tick;
  let started = false;
  const planOutput = { ...output, tick: () => { if (!started) { started = true; onEvent({ type: "status", text: "Planning the itinerary…" }); } tick(); } };
  if (kind === "ollama") await planWithOllama({ base, model, prompt, trip, abort, onEvent, output: planOutput });
  else await planWithOpenAi({ base, model, prompt, abort, onEvent, output: planOutput });

  let parsed;
  try { parsed = parseJsonLoose(out.content); } catch { /* reported below */ }
  const itinerary = normalizeItinerary(parsed, Number(trip.travelers) || 1);
  if (!itinerary) {
    const why = !out.content.trim()
      ? (out.thinking ? `It only thought (${out.thinking.length.toLocaleString()} characters) and never wrote the itinerary.` : "It returned nothing.")
      : "Its answer wasn't a valid itinerary.";
    throw new Error(`${model} didn't return a usable itinerary. ${why} Try again, a bigger model, or fewer saved places.`
      + (out.content.trim() ? `\n\nIts answer began:\n${out.content.slice(0, 600)}` : out.thinking ? `\n\nEnd of its thinking:\n…${out.thinking.slice(-600)}` : ""));
  }
  if (!trip.redoDay && !trip.fix && !trip.edit) addMissingMustSees(itinerary, trip.mustSee || []);
  let reasoning = String(itinerary.planningNotes || "").trim();
  delete itinerary.planningNotes;
  if (research?.notes) {
    reasoning += `\n\n**Research findings**\n\n${research.notes}`;
    const found = [...new Set([...research.urls, ...(research.notes.match(/https?:\/\/[^\s)\]]+/g) || [])])];
    // The model's own list first (it often names only a few), then every page that was read.
    itinerary.sources = [...new Set([...(itinerary.sources || []), ...found])];
  }
  return {
    itinerary, reasoning, thinking: out.thinking.trim().slice(0, 20000), durationMs: Date.now() - t0,
    tokens: out.tokens, perSec: out.perSec, engine: `${model} (${serverName(kind, base)})`, billing: "local",
  };
};
