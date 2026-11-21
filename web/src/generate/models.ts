// The Model menu: Claude via Claude Code, models reached with an API key (Anthropic, OpenAI, OpenRouter), any local
// model servers that are running, and the research toggle.
import type { CloudModel, CloudProvider, LocalModel, ModelsResponse } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { save, state } from "../core/state";
import { openKeys } from "./keys";

let localModels: LocalModel[] = [], cloudModels: CloudModel[] = [];
export let lastModels: ModelsResponse | null = null;
export const isLocal = (id: string) => String(id).startsWith("local|");
export const isApi = (id: string) => String(id).startsWith("api|");
const PROVIDER_NAME: Record<CloudProvider, string> = { anthropic: "Anthropic API", openai: "OpenAI API", openrouter: "OpenRouter" };
const ADD_KEY = "__keys";

export function modelLabel(id: string) {
  if (isApi(id)) return cloudModels.find((m) => m.id === id)?.name || id.split("|").slice(2).join("|");
  if (!isLocal(id)) return "Claude";
  return localModels.find((x) => x.id === id)?.name || id.split("|")[3];
}

const gb = (n?: number) => (n ? ` · ${(n / 1e9).toFixed(1)} GB` : "");
const option = (value: string, text: string) => `<option value="${esc(value)}">${esc(text)}</option>`;

export async function refreshModels() {
  const sel = $<HTMLSelectElement>("#model");
  try { lastModels = await api<ModelsResponse>("/api/models"); } catch { lastModels = null; }
  localModels = lastModels?.local || []; cloudModels = lastModels?.cloud || [];
  let html = `<optgroup label="Claude (via Claude Code, uses your plan)">
      ${option("default", "Claude · CLI default")}${option("opus", "Claude Opus")}${option("sonnet", "Claude Sonnet")}${option("haiku", "Claude Haiku (fast)")}</optgroup>`;
  for (const p of Object.keys(PROVIDER_NAME) as CloudProvider[]) {
    const ms = cloudModels.filter((m) => m.provider === p);
    if (ms.length) html += `<optgroup label="${esc(PROVIDER_NAME[p])} (your key, pay per use)">${ms.map((m) => option(m.id, m.name)).join("")}</optgroup>`;
  }
  const groups: Record<string, LocalModel[]> = {};
  for (const m of localModels) (groups[m.server] ||= []).push(m);
  for (const [server, ms] of Object.entries(groups)) {
    html += `<optgroup label="Local · ${esc(server)} (free)">${ms.map((m) => option(m.id, m.name + gb(m.size))).join("")}</optgroup>`;
  }
  // Keep a saved choice visible even while its server is off or its key is gone.
  if ((isLocal(state.model) && !localModels.some((m) => m.id === state.model)) || (isApi(state.model) && !cloudModels.some((m) => m.id === state.model))) {
    html += `<optgroup label="Not available">${option(state.model, `${modelLabel(state.model)} (${isApi(state.model) ? "no key" : "offline"})`)}</optgroup>`;
  }
  html += `<optgroup label="More">${option(ADD_KEY, "🔑 Add or change API keys…")}</optgroup>`;
  sel.innerHTML = html;
  sel.value = state.model;
  if (sel.value !== state.model) sel.value = "default";
  syncResearch();
  const errors = Object.entries(lastModels?.errors || {}).map(([p, e]) => `${PROVIDER_NAME[p as CloudProvider]}: ${e}`);
  $("#modelHint").textContent = [
    localModels.length ? `${localModels.length} local model${localModels.length > 1 ? "s" : ""} found (free, but weaker at long plans).` : "No local model server running.",
    cloudModels.length ? `${cloudModels.length} API models available.` : "",
    ...errors,
  ].filter(Boolean).join(" ");
}

/** Web research is on by default. Claude Code and API models search the web themselves; for local models the
 *  planner runs the searches for them (they need tool support, otherwise they plan without it). */
export function syncResearch() {
  $<HTMLInputElement>("#research").checked = state.research !== false;
  $("#researchHint").textContent = isLocal(state.model)
    ? ": the model looks things up through the planner (DuckDuckGo) before planning; needs a model with tool support"
    : isApi(state.model)
      ? ": the model uses its provider's own web search (billed per search on top of tokens)"
      : ": Claude checks opening hours, prices and events on the web (slower, more accurate)";
}

export function initModels() {
  $("#refreshModels").onclick = refreshModels;
  $("#openKeys").onclick = () => openKeys(refreshModels);
  $("#model").addEventListener("focus", refreshModels, { once: true });
  $<HTMLSelectElement>("#model").addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.value === ADD_KEY) { sel.value = state.model; openKeys(refreshModels); return; }
    syncResearch();
  });
  $<HTMLInputElement>("#research").onchange = (e) => { state.research = (e.target as HTMLInputElement).checked; save(); };
}
