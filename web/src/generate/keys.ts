// The API keys dialog: add, replace or remove a key per provider. Keys go straight to the local server (stored in
// keys.json there); the page only ever gets back whether a key is set and its last characters.
import type { CloudProvider, KeyStatus } from "../../../shared/types";
import { $, $$, api, esc } from "../core/dom";

const PROVIDERS: { id: CloudProvider; name: string; env: string; url: string; note: string }[] = [
  { id: "anthropic", name: "Anthropic", env: "ANTHROPIC_API_KEY", url: "https://console.anthropic.com/settings/keys", note: "Claude models with Anthropic's web search." },
  { id: "openai", name: "OpenAI", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys", note: "GPT models with OpenAI's web search." },
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/keys", note: "One key for many labs' models (Claude, GPT, Gemini, Qwen, DeepSeek…)." },
];

function rowHtml(p: (typeof PROVIDERS)[number], s: KeyStatus | undefined) {
  const status = !s?.set ? "No key" : s.source === "env" ? `Set from ${p.env} (${esc(s.hint)})` : `Saved (${esc(s.hint)})`;
  return `<div class="key-row" data-provider="${p.id}">
    <div class="key-head"><b>${p.name}</b> <span class="hint">${status}</span>
      <a class="link-btn" href="${p.url}" target="_blank" rel="noopener">get a key ↗</a></div>
    <div class="hint">${p.note}</div>
    ${s?.source === "env"
      ? `<div class="hint">Change it where ${p.env} is set (environment or .env file).</div>`
      : `<div class="inline">
          <input type="password" autocomplete="off" spellcheck="false" placeholder="${s?.set ? "Paste a new key to replace it" : "Paste your API key"}">
          <button class="btn solid" data-save>Save</button>
          ${s?.set ? `<button class="btn" data-remove title="Remove this key">✕</button>` : ""}
        </div>`}
  </div>`;
}

async function render(dialog: HTMLDialogElement, keys?: Record<CloudProvider, KeyStatus>) {
  keys ||= (await api<{ keys: Record<CloudProvider, KeyStatus> }>("/api/models").catch(() => null))?.keys;
  $("#keyRows").innerHTML = PROVIDERS.map((p) => rowHtml(p, keys?.[p.id])).join("");
  for (const row of $$("[data-provider]", dialog)) {
    const provider = row.dataset.provider as CloudProvider;
    const put = async (key: string) => {
      try { await render(dialog, await api(`/api/keys/${provider}`, { method: "PUT", body: JSON.stringify({ key }) })); changed = true; }
      catch (e) { $("#keyStatus").textContent = (e as Error).message; }
    };
    row.querySelector<HTMLButtonElement>("[data-save]")?.addEventListener("click", () => {
      const key = row.querySelector("input")!.value.trim();
      if (key) put(key);
    });
    row.querySelector<HTMLButtonElement>("[data-remove]")?.addEventListener("click", () => {
      if (confirm(`Remove the saved ${provider} key?`)) put("");
    });
  }
}

let changed = false;

/** Opens the dialog; onChange runs after it closes if a key was added or removed. */
export function openKeys(onChange: () => void) {
  const dialog = $<HTMLDialogElement>("#keysDialog");
  changed = false;
  $("#keyStatus").textContent = "";
  dialog.onclose = () => { if (changed) onChange(); };
  render(dialog);
  dialog.showModal();
}
