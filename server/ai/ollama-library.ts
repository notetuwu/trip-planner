// Ollama's model library (ollama.com), read live so the settings never offer an outdated list: search by name or
// capability, each model's sizes with their download size and context window, and models that fit this computer's
// graphics memory. ollama.com has no public API for this, so it reads the pages (cached; on any change in their layout
// the settings fall back to a built-in list).
import { USER_AGENT } from "../config";
import { diskCache } from "../util/disk-cache";

export interface LibraryModel {
  name: string; description: string; caps: string[]; sizes: string[]; downloads: number; context: string; updated: string;
  /** Runs only on Ollama's cloud, not on this computer. */
  cloudOnly: boolean;
}
export interface LibraryTag { name: string; sizeGb: number; context: string; inputs: string }
export interface Recommendation { model: string; tag: string; sizeGb: number; context: string; caps: string[]; description: string; downloads: number }

const BASE = "https://ollama.com";
const tagCache = diskCache<{ at: number; tags: LibraryTag[] }>("ollama-tags.json");
const searchCache = new Map<string, { at: number; models: LibraryModel[] }>();

async function page(path: string) {
  const res = await fetch(BASE + path, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`ollama.com: HTTP ${res.status}`);
  return res.text();
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const badge = (html: string, colour: string) => [...html.matchAll(new RegExp(`<span\\s+class="[^"]*${colour}[^"]*">([^<]+)</span>`, "g"))].map((m) => m[1].trim());

/** The models on a search page: name, what they can do, their sizes, downloads. */
export function parseSearch(html: string): LibraryModel[] {
  return html.split(/<li\b/).slice(1).map((li) => {
    const name = li.match(/<a href="\/library\/([^"]+)"/)?.[1];
    if (!name) return null;
    const caps = badge(li, "text-indigo-600");
    const sizes = badge(li, "text-blue-600");
    const cloud = badge(li, "text-cyan-500").includes("cloud");
    const downloads = Number(li.match(/title="([\d,]+) downloads"/)?.[1].replace(/,/g, "") || 0);
    const context = text(li.match(/title="Context window"[^>]*>(?:<svg.*?<\/svg>)?\s*<span[^>]*>([^<]*)<\/span>/s)?.[1] || "");
    return {
      name: decodeURIComponent(name), description: text(li.match(/<p class="[^"]*line-clamp[^"]*">(.*?)<\/p>/s)?.[1] || ""),
      caps, sizes, downloads, context, updated: li.match(/title="Updated ([^"]+)"/)?.[1] || "",
      cloudOnly: cloud && !sizes.length,
    };
  }).filter((m): m is LibraryModel => !!m);
}

/** A model's tags with their download size and context window ("qwen3.8:27b · 18GB · 256K context window"). */
export function parseTags(html: string, model: string): LibraryTag[] {
  const out = new Map<string, LibraryTag>();
  const re = new RegExp(`href="/library/(${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[^"]+)"[^>]*>(.*?)</a>`, "gs");
  for (const m of html.matchAll(re)) {
    const info = text(m[2]);
    const size = info.match(/([\d.]+)\s*(GB|MB|TB)\b/);
    if (!size || out.has(m[1])) continue;
    const gb = Number(size[1]) * (size[2] === "MB" ? 1 / 1024 : size[2] === "TB" ? 1024 : 1);
    out.set(m[1], {
      name: m[1], sizeGb: Math.round(gb * 10) / 10, context: info.match(/([\d.]+[KM]) context window/)?.[1] || "",
      inputs: info.match(/((?:Text|Image|Audio|Video)(?:, (?:Text|Image|Audio|Video))*) input/)?.[1] || "",
    });
  }
  return [...out.values()];
}

/** Models matching a search, optionally only those with a capability (tools, thinking, vision). Cached for 6 hours. */
export async function searchLibrary(q = "", cap = ""): Promise<LibraryModel[]> {
  const key = `${q}|${cap}`, hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.models;
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(cap ? { c: cap } : {}) });
  const pages = await Promise.all([1, 2].map((p) => page(`/search?${qs}${p > 1 ? `&p=${p}` : ""}`).catch(() => "")));
  const seen = new Set<string>();
  const models = pages.flatMap(parseSearch).filter((m) => !seen.has(m.name) && seen.add(m.name));
  if (!models.length && !pages.some(Boolean)) throw new Error("Couldn't reach ollama.com");
  searchCache.set(key, { at: Date.now(), models });
  return models;
}

/** A model's tags (sizes and variants). Cached for a day. */
export async function libraryTags(model: string): Promise<LibraryTag[]> {
  const hit = tagCache.data[model];
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.tags;
  const tags = parseTags(await page(`/library/${encodeURIComponent(model)}/tags`), model);
  tagCache.data[model] = { at: Date.now(), tags };
  tagCache.save();
  return tags;
}

/** The main sizes of a model ("qwen3.8:27b"), without "latest" and the variants ("-q8_0", "-mlx", "-bf16"…). */
export const mainTags = (tags: LibraryTag[]) => tags.filter((t) => !/:latest$/.test(t.name) && !t.name.split(":")[1].includes("-"));

/** Room a model needs beyond its download: the context and the runtime (more with long prompts). */
export const headroomGb = (sizeGb: number) => Math.max(2.5, sizeGb * 0.15);

/**
 * Models for planning that fit this graphics memory: current models that can use tools (most popular first, thinking
 * ones preferred), each in the biggest size that fits with room for the planner's long prompts. The best few.
 */
export async function recommend(memGb: number, unified = false, count = 4): Promise<Recommendation[]> {
  const usable = unified ? memGb * 0.65 : memGb;
  const models = (await searchLibrary("", "tools"))
    .filter((m) => !m.cloudOnly && m.sizes.length && !m.caps.includes("embedding"))
    .sort((a, b) => Number(b.caps.includes("thinking")) - Number(a.caps.includes("thinking")) || b.downloads - a.downloads)
    .slice(0, 10);
  const picks: Recommendation[] = [];
  for (const m of models) {
    const tags = await libraryTags(m.name).catch(() => [] as LibraryTag[]);
    const fits = mainTags(tags).filter((t) => t.sizeGb + headroomGb(t.sizeGb) <= usable).sort((a, b) => b.sizeGb - a.sizeGb);
    if (fits[0]) picks.push({ model: m.name, tag: fits[0].name, sizeGb: fits[0].sizeGb, context: fits[0].context, caps: m.caps, description: m.description, downloads: m.downloads });
    if (picks.length >= count + 2) break;
  }
  // Bigger plans better; among similar sizes, the more popular.
  return picks.sort((a, b) => Math.round(b.sizeGb / 4) - Math.round(a.sizeGb / 4) || b.downloads - a.downloads).slice(0, count);
}
