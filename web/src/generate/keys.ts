// The AI providers' API keys: add, replace or remove a key per provider. Keys go straight to the local server (stored in
// keys.json there); the page only ever gets back whether a key is set and its last characters. They're shown in
// Settings → API keys and in the quick-start guide, with the same key field as the other keys (key-field.ts).
import type { CloudProvider, KeyStatus } from "../../../shared/types";
import { api } from "../core/dom";
import { keyFieldHtml, wireKeyFields } from "../settings/key-field";

export const PROVIDERS: { id: CloudProvider; name: string; env: string; url: string; note: string }[] = [
  { id: "anthropic", name: "Anthropic", env: "ANTHROPIC_API_KEY", url: "https://console.anthropic.com/settings/keys", note: "Claude models with Anthropic's web search." },
  { id: "openai", name: "OpenAI", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys", note: "GPT models with OpenAI's web search." },
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/keys", note: "One key for many labs' models (Claude, GPT, Gemini, Qwen, DeepSeek…)." },
];
const NAMES = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.name]));

/**
 * The key fields in `rows` (Settings → API keys, or the quick-start guide), saving and removing straight away; problems
 * show under the field. onSaved runs after each change, with what's set now.
 */
export async function renderKeyRows(rows: HTMLElement, onSaved: (keys: Record<CloudProvider, KeyStatus>) => void, keys?: Record<CloudProvider, KeyStatus>) {
  keys ||= (await api<{ keys: Record<CloudProvider, KeyStatus> }>("/api/models").catch(() => null))?.keys;
  rows.innerHTML = PROVIDERS.map((p) => keyFieldHtml({ id: p.id, name: p.name, status: keys?.[p.id], env: p.env, url: p.url, note: p.note })).join("");
  wireKeyFields(rows, async (id, key) => {
    const now = await api<Record<CloudProvider, KeyStatus>>(`/api/keys/${id}`, { method: "PUT", body: JSON.stringify({ key }) });
    await renderKeyRows(rows, onSaved, now);
    onSaved(now);
  }, NAMES);
}

/** Opens Settings at API keys; onChange runs once it closes, if a key was added or removed there. */
export function openKeys(onChange: () => void) {
  import("../settings/settings").then((m) => m.openSettings("keys", onChange));
}
