// Models reachable with an API key, listed live from each provider (cached for a few minutes).
import Anthropic from "@anthropic-ai/sdk";
import type { CloudModel, CloudProvider } from "../../shared/types";
import { errMsg } from "../config";
import { getKey } from "../keys";
import { BASE } from "./responses";

/** Most output tokens each Anthropic model allows, from the Models API (used as max_tokens). */
export const anthropicMaxTokens = new Map<string, number>();

/** Model ids look like "api|<provider>|<model>". */
export function parseCloudId(id: string) {
  const [, provider, ...rest] = id.split("|");
  return { provider: provider as CloudProvider, model: rest.join("|") };
}
const entry = (provider: CloudProvider, model: string, name: string): CloudModel => ({ id: `api|${provider}|${model}`, name, provider });

async function anthropicModels(key: string) {
  const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 10000 });
  const out: CloudModel[] = [];
  for await (const m of client.models.list()) {
    if (!m.id.startsWith("claude-")) continue;
    if (m.max_tokens) anthropicMaxTokens.set(m.id, m.max_tokens);
    out.push(entry("anthropic", m.id, m.display_name || m.id));
  }
  return out;
}

async function bearerJson(url: string, key?: string): Promise<any> {
  const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// OpenAI lists every model it has (audio, images, embeddings…); keep the text models that can plan.
const OPENAI_SKIP = /audio|realtime|tts|transcribe|image|embedding|moderation|search|dall-e|whisper|codex|instruct|babbage|davinci|-\d{4}-\d{2}-\d{2}$/;
async function openaiModels(key: string) {
  const data = await bearerJson(`${BASE.openai}/models`, key);
  return (data.data || [])
    .filter((m: any) => /^(gpt-|o\d)/.test(m.id) && !OPENAI_SKIP.test(m.id))
    .sort((a: any, b: any) => (b.created || 0) - (a.created || 0)).slice(0, 20)
    .map((m: any) => entry("openai", m.id, m.id));
}

// OpenRouter has hundreds of models; offer recent ones from the big labs that can return structured JSON.
const OPENROUTER_LABS = /^(anthropic|openai|google|qwen|deepseek|mistralai|meta-llama|x-ai|moonshotai|z-ai)\//;
async function openrouterModels() {
  const data = await bearerJson(`${BASE.openrouter}/models`);
  return (data.data || [])
    .filter((m: any) => OPENROUTER_LABS.test(m.id) && (m.supported_parameters || []).includes("structured_outputs"))
    .sort((a: any, b: any) => (b.created || 0) - (a.created || 0)).slice(0, 40)
    .map((m: any) => entry("openrouter", m.id, m.name || m.id));
}

const LISTERS: Record<CloudProvider, (key: string) => Promise<CloudModel[]>> = {
  anthropic: anthropicModels, openai: openaiModels, openrouter: () => openrouterModels(),
};

const cache = new Map<string, { at: number; models: CloudModel[] }>();
const TTL = 10 * 60 * 1000;

/** Models of every provider with a key, plus what went wrong for the others (e.g. a rejected key). */
export async function cloudModels() {
  const models: CloudModel[] = [], errors: Partial<Record<CloudProvider, string>> = {};
  await Promise.all((Object.keys(LISTERS) as CloudProvider[]).map(async (p) => {
    const key = getKey(p);
    if (!key) return;
    const cacheKey = `${p}|${key.slice(-8)}`, hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < TTL) return models.push(...hit.models);
    try {
      const list = await LISTERS[p](key);
      cache.set(cacheKey, { at: Date.now(), models: list });
      models.push(...list);
    } catch (e) { errors[p] = errMsg(e).slice(0, 200); }
  }));
  return { models, errors };
}
