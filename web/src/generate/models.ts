// The Model menu: Claude via Claude Code, models reached with an API key (Anthropic, OpenAI, OpenRouter), any local
// model servers that are running, and the research toggle.
import type { CloudModel, CloudProvider, LocalModel, ModelsResponse } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { save, state } from "../core/state";
import { openKeys } from "./keys";
import { openSettings } from "../settings/settings";
import { openQuickstart } from "../setup/quickstart";

let localModels: LocalModel[] = [], cloudModels: CloudModel[] = [];
export let lastModels: ModelsResponse | null = null;
export const isLocal = (id: string) => String(id).startsWith("local|");
export const isApi = (id: string) => String(id).startsWith("api|");
const PROVIDER_NAME: Record<CloudProvider, string> = { anthropic: "Anthropic API", openai: "OpenAI API", openrouter: "OpenRouter" };
const ADD_KEY = "__keys", SETUP = "__setup";
/** Claude through Claude Code (the CLI): not "local|…" or "api|…". */
const isClaudeCode = (id: string) => !isLocal(id) && !isApi(id);

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
  // Claude only when Claude Code is on this computer (if the server can't be asked, as before: it's offered).
  const claude = lastModels ? lastModels.claude : true;
  let html = claude ? `<optgroup label="Claude (via Claude Code, uses your plan)">
      ${option("default", "Claude · CLI default")}${option("opus", "Claude Opus")}${option("sonnet", "Claude Sonnet")}${option("haiku", "Claude Haiku (fast)")}</optgroup>` : "";
  for (const p of Object.keys(PROVIDER_NAME) as CloudProvider[]) {
    const ms = cloudModels.filter((m) => m.provider === p);
    if (ms.length) html += `<optgroup label="${esc(PROVIDER_NAME[p])} (your key, pay per use)">${ms.map((m) => option(m.id, m.name)).join("")}</optgroup>`;
  }
  const groups: Record<string, LocalModel[]> = {};
  for (const m of localModels) (groups[m.server] ||= []).push(m);
  for (const [server, ms] of Object.entries(groups)) {
    html += `<optgroup label="Local · ${esc(server)} (free)">${ms.map((m) => option(m.id, m.name + gb(m.size))).join("")}</optgroup>`;
  }
  const usable = [...(claude ? ["default"] : []), ...cloudModels.map((m) => m.id), ...localModels.map((m) => m.id)];
  // Claude picked, but there's no Claude Code (any more): switch to a model that's there, if there is one.
  if (isClaudeCode(state.model) && !claude && usable.length) { state.model = usable[0]; save(); }
  // Keep a saved choice visible even while its server is off or its key is gone.
  if ((isLocal(state.model) && !localModels.some((m) => m.id === state.model)) || (isApi(state.model) && !cloudModels.some((m) => m.id === state.model))
    || (isClaudeCode(state.model) && !claude)) {
    const why = isApi(state.model) ? "no key" : isLocal(state.model) ? "offline" : "Claude Code not found";
    html += `<optgroup label="Not available">${option(state.model, `${modelLabel(state.model)} (${why})`)}</optgroup>`;
  }
  html += `<optgroup label="More">${option(SETUP, usable.length ? "Set up more models…" : "Set up a model to plan with…")}${option(ADD_KEY, "Add or change API keys…")}</optgroup>`;
  sel.innerHTML = html;
  sel.value = state.model;
  if (sel.value !== state.model) sel.value = usable[0] || state.model;
  syncResearch();
  const errors = Object.entries(lastModels?.errors || {}).map(([p, e]) => `${PROVIDER_NAME[p as CloudProvider]}: ${e}`);
  const hint = $("#modelHint");
  hint.textContent = [
    localModels.length ? `${localModels.length} local model${localModels.length > 1 ? "s" : ""} found (free, but weaker at long plans).` : "No local model yet.",
    cloudModels.length ? `${cloudModels.length} API models available.` : "",
    ...errors,
  ].filter(Boolean).join(" ") + " ";
  const guide = document.createElement("button");
  guide.className = "link-btn"; guide.type = "button";
  // Settings → Local models installs Ollama and models (with what fits this graphics card).
  guide.textContent = localModels.length ? "Manage local models" : "Set one up";
  guide.onclick = () => openSettings("models");
  hint.append(guide);
  return lastModels;
}

/** Web research is on by default. Claude Code and API models search the web themselves; for local models the
 *  planner runs the searches for them (they need tool support, otherwise they plan without it). */
export function syncResearch() {
  $<HTMLInputElement>("#research").checked = state.research !== false;
  $<HTMLInputElement>("#autoFix").checked = state.autoFix !== false;
  $<HTMLInputElement>("#hoursOnline").checked = !!state.hoursOnline;
  $<HTMLInputElement>("#hoursOnline").disabled = state.autoFix === false;
  const why = isLocal(state.model)
    ? "The model looks things up through the planner (DuckDuckGo) before planning; needs a model with tool support"
    : isApi(state.model)
      ? "The model uses its provider's own web search (billed per search on top of tokens)"
      : "Claude checks opening hours, prices and events on the web (slower, more accurate)";
  $("#researchHint").textContent = why;
  $("#researchRow").title = why;
}

export function initModels() {
  $("#refreshModels").onclick = refreshModels;
  $("#openKeys").onclick = () => openKeys(refreshModels);
  $("#model").addEventListener("focus", refreshModels, { once: true });
  $<HTMLSelectElement>("#model").addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.value === ADD_KEY) { sel.value = state.model; openKeys(refreshModels); return; }
    if (sel.value === SETUP) { sel.value = state.model; openQuickstart(); return; }
    syncResearch();
  });
  $<HTMLInputElement>("#research").onchange = (e) => { state.research = (e.target as HTMLInputElement).checked; save(); };
  $<HTMLInputElement>("#autoFix").onchange = (e) => { state.autoFix = (e.target as HTMLInputElement).checked; save(); syncResearch(); };
  $<HTMLInputElement>("#hoursOnline").onchange = (e) => { state.hoursOnline = (e.target as HTMLInputElement).checked; save(); };
}
