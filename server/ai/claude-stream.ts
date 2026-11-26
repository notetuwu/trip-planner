// Turns Claude's streamed events into progress events for the browser. Used for the Claude Code CLI's stream-json
// output (which wraps the API's events) and for the Anthropic API directly:
//   thinking  - how much it is thinking (plus the summarized thinking when the API sends it)
//   text      - Claude's planning notes, written before the itinerary
//   search / fetch - web lookups while researching, with their results as extra prompt parts
//   progress  - days of the itinerary written so far
import { noteClaudeLimit } from "./usage-notices";
import { daysWritten, tokenMeter } from "./output";
import type { OnEvent } from "./types";

const isSearch = (name: string) => /^web_?search$/i.test(name);
const isFetch = (name: string) => /^web_?fetch$/i.test(name);

/** outputTool: the tool the itinerary arrives through ("StructuredOutput" in Claude Code). */
export function claudeStreamHandler(onEvent: OnEvent, outputTool = "StructuredOutput") {
  const s = { result: null as any, reasoning: "", thinking: "", doneTokens: 0 };
  let json = "", days = 0, thinking = 0;
  let blocks: Record<number, { name: string; input: string }> = {}; // tool calls of the current message, by index
  const toolNames: Record<string, string> = {}; // tool_use id -> tool name, to label the results
  // Output tokens: exact for finished messages; for the one being written, estimated from thinking + written characters / 4.
  let msgThink = 0, msgChars = 0;
  let cliCounts = false; // the CLI reports thinking tokens itself; don't count its thinking text twice
  const meter = tokenMeter(onEvent, true);

  function toolResults(content: any[]) {
    for (const c of content) {
      if (c.type !== "tool_result") continue;
      const name = toolNames[c.tool_use_id] || "tool";
      if (name === outputTool) continue;
      const text = typeof c.content === "string" ? c.content : (c.content || []).map((x: any) => x.text || "").join("\n");
      onEvent({ type: "prompt", label: `Result of ${name}`, text });
    }
  }

  /** The API's own web search and fetch results arrive as content blocks of the assistant message. */
  function serverResult(block: any) {
    const c = block.content;
    if (block.type === "web_search_tool_result") {
      const text = Array.isArray(c) ? c.map((r: any) => `- ${r.title || ""} ${r.url}${r.page_age ? ` (${r.page_age})` : ""}`).join("\n") : `Error: ${c?.error_code || "unknown"}`;
      onEvent({ type: "prompt", label: "Result of web_search", text });
    } else if (block.type === "web_fetch_tool_result") {
      const doc = c?.content?.source?.data;
      onEvent({ type: "prompt", label: "Result of web_fetch", text: c?.error_code ? `Error: ${c.error_code}` : `${c?.url || ""}\n\n${typeof doc === "string" ? doc.slice(0, 4000) : ""}` });
    }
  }

  function toolFinished(index: number) {
    const b = blocks[index];
    let input: any = {};
    try { input = JSON.parse(b.input || "{}"); } catch { /* partial */ }
    if (isSearch(b.name) && input.query) onEvent({ type: "search", query: input.query });
    if (isFetch(b.name) && input.url) onEvent({ type: "fetch", url: input.url });
  }

  /** One raw Messages API stream event. */
  function event(se: any) {
    if (se.type === "message_start") { blocks = {}; msgThink = msgChars = 0; }
    if (se.type === "message_delta" && se.usage?.output_tokens) {
      s.doneTokens += se.usage.output_tokens; msgThink = msgChars = 0;
      meter(s.doneTokens, { force: true });
    }
    if (se.type === "content_block_start") {
      const cb = se.content_block || {};
      if (cb.type === "tool_use" || cb.type === "server_tool_use") {
        blocks[se.index] = { name: cb.name, input: "" };
        toolNames[cb.id] = cb.name;
      } else serverResult(cb);
    }
    if (se.type === "content_block_stop" && blocks[se.index]) toolFinished(se.index);
    if (se.type !== "content_block_delta") return;
    const d = se.delta;
    msgChars += (d.text || d.partial_json || "").length;
    if (d.type === "thinking_delta" && d.thinking) {
      s.thinking += d.thinking;
      const t = cliCounts ? 0 : d.thinking.length / 4;
      thinking += t; msgThink += t;
      onEvent({ type: "thinking", tokens: Math.round(thinking) });
    }
    meter(s.doneTokens + msgThink + msgChars / 4);
    if (d.type === "text_delta") { s.reasoning += d.text; onEvent({ type: "text", text: d.text }); }
    if (d.type === "input_json_delta" && blocks[se.index]) {
      blocks[se.index].input += d.partial_json;
      if (blocks[se.index].name !== outputTool) return;
      // The itinerary arrives as streamed JSON through the output tool.
      json += d.partial_json;
      const n = daysWritten(json);
      if (n !== days) { days = n; onEvent({ type: "progress", days }); }
    }
  }

  /** One line of the Claude Code CLI's stream-json output. */
  function handle(line: string) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "result") { s.result = ev; return; }
    if (ev.type === "rate_limit_event") { noteClaudeLimit(ev.rate_limit_info); return; }
    // Tool results (search results, fetched pages) go back to Claude as user messages: show them too.
    if (ev.type === "user" && Array.isArray(ev.message?.content)) return toolResults(ev.message.content);
    if (ev.type === "system" && ev.subtype === "thinking_tokens") {
      cliCounts = true;
      thinking += ev.estimated_tokens_delta || 0;
      msgThink += ev.estimated_tokens_delta || 0;
      meter(s.doneTokens + msgThink + msgChars / 4);
      return onEvent({ type: "thinking", tokens: Math.round(thinking) });
    }
    if (ev.type === "stream_event" && ev.event) event(ev.event);
  }

  return { handle, event, state: s };
}
