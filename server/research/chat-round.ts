// One turn of the research conversation with a local model, with web_search / fetch_page offered as tools.
import { lines } from "../util/http";

export const MAX_LOOKUPS = Number(process.env.RESEARCH_MAX_LOOKUPS) || 30;
/** One fixed context size for the whole conversation (changing it makes Ollama reload the model). It holds every
 *  search result and page the model reads, at most ~1k tokens each. */
export const RESEARCH_CTX = Math.min(Number(process.env.OLLAMA_NUM_CTX) || 65536, Math.ceil((MAX_LOOKUPS * 1100 + 8000) / 4096) * 4096);

const TOOLS = [
  { type: "function", function: { name: "web_search", description: "Search the web. Returns result titles, URLs and snippets.", parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } } } },
  { type: "function", function: { name: "fetch_page", description: "Read a web page as plain text (first few thousand characters).", parameters: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } },
];

export interface ToolCall { id?: string; name: string; args: { query?: string; url?: string } }
export interface RoundContext {
  kind: "ollama" | "openai";
  base: string;
  model: string;
  messages: any[];
  abort: AbortSignal;
  onThinking(text: string): void;
  tick(): void;
}

/** Sends the conversation so far; appends the model's reply to `messages` and returns its text and tool calls. */
export async function chatRound(ctx: RoundContext, allowTools: boolean): Promise<{ content: string; calls: ToolCall[] }> {
  const { kind, base, model, messages, abort } = ctx;
  let content = "", calls: ToolCall[] = [];
  if (kind === "ollama") {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST", signal: abort,
      body: JSON.stringify({ model, stream: true, messages, ...(allowTools ? { tools: TOOLS } : {}), options: { num_ctx: RESEARCH_CTX, temperature: 0.3 } }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (/does not support tools/i.test(err)) throw new Error("NO_TOOLS");
      throw new Error(`Ollama: ${err.slice(0, 300)}`);
    }
    for await (const line of lines(res.body)) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.error) throw new Error(`Ollama: ${ev.error}`);
      if (ev.message?.thinking || ev.message?.content) ctx.tick();
      if (ev.message?.thinking) ctx.onThinking(ev.message.thinking);
      if (ev.message?.content) content += ev.message.content;
      if (ev.message?.tool_calls) calls.push(...ev.message.tool_calls.map((c: any) => ({ name: c.function.name, args: c.function.arguments || {} })));
    }
    messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}) });
    return { content, calls };
  }
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", signal: abort, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, temperature: 0.3, messages, ...(allowTools ? { tools: TOOLS } : {}) }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 422) throw new Error("NO_TOOLS");
    throw new Error(`${base}: ${(await res.text()).slice(0, 300)}`);
  }
  const msg = ((await res.json()) as any).choices?.[0]?.message || {};
  if (msg.reasoning_content || msg.reasoning) ctx.onThinking(msg.reasoning_content || msg.reasoning);
  content = msg.content || "";
  calls = (msg.tool_calls || []).map((c: any) => {
    let args = {};
    try { args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments) : c.function.arguments || {}; } catch { /* bad JSON */ }
    return { id: c.id, name: c.function.name, args };
  });
  messages.push({ role: "assistant", content, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
  return { content, calls };
}
