// The Model menu: Claude via Claude Code plus any local model servers that are running, and the research toggle.
import type { LocalModel } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { save, state } from "../core/state";

let localModels: LocalModel[] = [];
export const isLocal = (id: string) => String(id).startsWith("local|");

export function modelLabel(id: string) {
  if (!isLocal(id)) return "Claude";
  return localModels.find((x) => x.id === id)?.name || id.split("|")[3];
}

const gb = (n?: number) => (n ? ` · ${(n / 1e9).toFixed(1)} GB` : "");

export async function refreshModels() {
  const sel = $<HTMLSelectElement>("#model");
  try { localModels = (await api<{ local: LocalModel[] }>("/api/models")).local; } catch { localModels = []; }
  const groups: Record<string, LocalModel[]> = {};
  for (const m of localModels) (groups[m.server] ||= []).push(m);
  let html = `<optgroup label="Claude (via Claude Code)">
      <option value="default">Claude · CLI default</option><option value="opus">Claude Opus</option>
      <option value="sonnet">Claude Sonnet</option><option value="haiku">Claude Haiku (fast)</option></optgroup>`;
  for (const [server, ms] of Object.entries(groups)) {
    html += `<optgroup label="Local · ${esc(server)}">${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${gb(m.size)}</option>`).join("")}</optgroup>`;
  }
  // Keep a saved local choice visible even while its server is off.
  if (isLocal(state.model) && !localModels.some((m) => m.id === state.model)) {
    html += `<optgroup label="Not running"><option value="${esc(state.model)}">${esc(modelLabel(state.model))} (offline)</option></optgroup>`;
  }
  sel.innerHTML = html;
  sel.value = state.model;
  if (sel.value !== state.model) sel.value = "default";
  syncResearch();
  $("#modelHint").textContent = localModels.length
    ? `${localModels.length} local model${localModels.length > 1 ? "s" : ""} found. Local models are free but weaker at long plans than Claude.`
    : "No local model server running (Ollama, LM Studio, llama.cpp, Jan, vLLM, KoboldCpp, text-generation-webui, GPT4All).";
}

/** Web research is on by default. Claude browses itself; for local models the planner runs the searches for them
 *  (they need tool support, otherwise they plan without it). */
export function syncResearch() {
  $<HTMLInputElement>("#research").checked = state.research !== false;
  $("#researchHint").textContent = isLocal(state.model)
    ? ": the model looks things up through the planner (DuckDuckGo) before planning; needs a model with tool support"
    : ": Claude checks opening hours, prices and events on the web (slower, more accurate)";
}

export function initModels() {
  $("#refreshModels").onclick = refreshModels;
  $("#model").addEventListener("focus", refreshModels, { once: true });
  $("#model").addEventListener("change", syncResearch);
  $<HTMLInputElement>("#research").onchange = (e) => { state.research = (e.target as HTMLInputElement).checked; save(); };
}
