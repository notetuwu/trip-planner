// Reading Ollama's library pages (search results and a model's tags), with markup shaped like ollama.com's.
import { describe, expect, it } from "vitest";
import { headroomGb, mainTags, parseSearch, parseTags } from "../server/ai/ollama-library";

const badge = (colour: string, t: string) => `<span  class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${colour} sm:text-[13px]">${t}</span>`;
const item = (name: string, caps: string[], sizes: string[], o: { cloud?: boolean; downloads?: string } = {}) => `
<li  class="border-t-[0.5px] border-line first:border-t-0">
  <a href="/library/${name}" class="group grid">
    <div class="flex"><h2 class="truncate" title="${name}"><span >${name}</span></h2>
      <span class="flex-none text-[15px] tabular-nums text-muted" title="Updated November 8, 2026">2w</span></div>
    <div class="order-last">${caps.map((c) => badge("text-indigo-600", c)).join("")}${o.cloud ? badge("text-cyan-500", "cloud") : ""}</div>
    <p class="mt-1 line-clamp-2 text-[15px] leading-6 text-black sm:col-span-2">A model &amp; its story.</p>
    <div class="mt-3">
      ${o.downloads ? `<span class="inline-flex" title="${o.downloads} downloads"><svg class="x"><path d="M1"/></svg><span >7.2M</span></span>` : ""}
      <span class="inline-flex items-center gap-1.5 text-ink sm:mr-1" title="Context window"><svg class="flex-none"><path d="M3"/></svg><span >256K</span></span>
      ${sizes.map((s) => badge("bg-[#ddf4ff] text-blue-600", s)).join("")}
    </div>
  </a>
</li>`;

describe("Ollama's library", () => {
  it("reads search results: capabilities, sizes, downloads, cloud-only models", () => {
    const html = `<ul>${item("qwen3.8", ["vision", "tools", "thinking"], ["27b"], { downloads: "7,187,015" })}${item("glm-5.3", ["tools"], [], { cloud: true, downloads: "102,045" })}</ul>`;
    const [a, b] = parseSearch(html);
    expect(a).toMatchObject({ name: "qwen3.8", caps: ["vision", "tools", "thinking"], sizes: ["27b"], downloads: 7187015, context: "256K", cloudOnly: false, description: "A model & its story." });
    expect(b).toMatchObject({ name: "glm-5.3", sizes: [], cloudOnly: true });
  });
  it("reads a model's tags with their download size and context window, and picks the main sizes", () => {
    const tag = (t: string, size: string) => `<a href="/library/qwen3.8:${t}" class="md:hidden flex"><span>qwen3.8:${t}</span>
      <span class="font-mono">e118e4d12a70</span> · ${size} · 256K context window · Text, Image input · 1 month ago</a>`;
    const tags = parseTags(tag("latest", "18GB") + tag("27b", "18GB") + tag("27b-q8_0", "30GB") + tag("4b", "3.3GB") + tag("27b", "18GB"), "qwen3.8");
    expect(tags.map((t) => [t.name, t.sizeGb, t.context])).toEqual([["qwen3.8:latest", 18, "256K"], ["qwen3.8:27b", 18, "256K"], ["qwen3.8:27b-q8_0", 30, "256K"], ["qwen3.8:4b", 3.3, "256K"]]);
    expect(tags[0].inputs).toBe("Text, Image");
    expect(mainTags(tags).map((t) => t.name)).toEqual(["qwen3.8:27b", "qwen3.8:4b"]);
  });
  it("leaves room for the context: an 18 GB model fits a 24 GB card, not a 20 GB one", () => {
    expect(18 + headroomGb(18) <= 24).toBe(true);
    expect(18 + headroomGb(18) <= 20).toBe(false);
  });
});
