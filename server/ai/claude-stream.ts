// Turns the Claude Code CLI's stream-json output into progress events for the browser:
//   thinking  - the CLI only reports how much it is thinking, not the thinking itself
//   text      - Claude's planning notes, written before the itinerary
//   search / fetch - web lookups while researching, with their results as extra prompt parts
//   progress  - days of the itinerary written so far
import { daysWritten, tokenMeter } from "./output";
import type { OnEvent } from "./types";

export function claudeStreamHandler(onEvent: OnEvent) {
  const s = { result: null as any, reasoning: "", doneTokens: 0 };
  let json = "", days = 0, thinking = 0;
  let blocks: Record<number, { name: string; input: string }> = {}; // tool calls of the current message, by index
  const toolNames: Record<string, string> = {}; // tool_use id -> tool name, to label the results
  // Output tokens: exact for finished messages; for the one being written, estimated from the
  // CLI's thinking-token updates plus written characters / 4.
  let msgThink = 0, msgChars = 0;
  const meter = tokenMeter(onEvent, true);

  function toolResults(content: any[]) {
    for (const c of content) {
      if (c.type !== "tool_result") continue;
      const name = toolNames[c.tool_use_id] || "tool";
      if (name === "StructuredOutput") continue;
      const text = typeof c.content === "string" ? c.content : (c.content || []).map((x: any) => x.text || "").join("\n");
      onEvent({ type: "prompt", label: `Result of ${name}`, text });
    }
  }

  function toolFinished(index: number) {
    const b = blocks[index];
    let input: any = {};
    try { input = JSON.parse(b.input || "{}"); } catch { /* partial */ }
    if (b.name === "WebSearch" && input.query) onEvent({ type: "search", query: input.query });
    if (b.name === "WebFetch" && input.url) onEvent({ type: "fetch", url: input.url });
  }

  function handle(line: string) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "result") { s.result = ev; return; }
    // Tool results (search results, fetched pages) go back to Claude as user messages: show them too.
    if (ev.type === "user" && Array.isArray(ev.message?.content)) return toolResults(ev.message.content);
    if (ev.type === "system" && ev.subtype === "thinking_tokens") {
      thinking += ev.estimated_tokens_delta || 0;
      msgThink += ev.estimated_tokens_delta || 0;
      meter(s.doneTokens + msgThink + msgChars / 4);
      return onEvent({ type: "thinking", tokens: thinking });
    }
    const se = ev.type === "stream_event" ? ev.event : null;
    if (!se) return;
    if (se.type === "message_start") { blocks = {}; msgThink = msgChars = 0; }
    if (se.type === "message_delta" && se.usage?.output_tokens) {
      s.doneTokens += se.usage.output_tokens; msgThink = msgChars = 0;
      meter(s.doneTokens, { force: true });
    }
    if (se.type === "content_block_start" && se.content_block?.type === "tool_use") {
      blocks[se.index] = { name: se.content_block.name, input: "" };
      toolNames[se.content_block.id] = se.content_block.name;
    }
    if (se.type === "content_block_stop" && blocks[se.index]) toolFinished(se.index);
    if (se.type !== "content_block_delta") return;
    const d = se.delta;
    msgChars += (d.text || d.partial_json || "").length;
    meter(s.doneTokens + msgThink + msgChars / 4);
    if (d.type === "text_delta") { s.reasoning += d.text; onEvent({ type: "text", text: d.text }); }
    if (d.type === "input_json_delta" && blocks[se.index]) {
      blocks[se.index].input += d.partial_json;
      if (blocks[se.index].name !== "StructuredOutput") return;
      // The itinerary arrives as streamed JSON through the StructuredOutput tool.
      json += d.partial_json;
      const n = daysWritten(json);
      if (n !== days) { days = n; onEvent({ type: "progress", days }); }
    }
  }

  return { handle, state: s };
}
