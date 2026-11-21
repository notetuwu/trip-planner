// A short one-off question to whichever model is selected (no tools), for helper tasks such as picking stops along a
// route or proposing the stays of a trip. Answers are expected as JSON in the reply text. onProgress gets the number of
// tokens written so far, for a live count while it works (where the model streams); onText gets the reply so far and
// any thinking the model shows, so the page can show its reasoning. `signal` cancels the request.
import { spawn } from "node:child_process";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { getKey, PROVIDERS } from "../keys";
import { lines } from "../util/http";
import { findClaude } from "./claude-bin";
import { parseCloudId } from "./cloud-models";
import { parseModelId } from "./local-models";
import { BASE } from "./responses";

const TIMEOUT = 6 * 60_000;
export type OnProgress = (tokens: number) => void;
export interface AskOptions {
  signal?: AbortSignal;
  /** The reply so far and the model's own thinking so far (where it shows any). */
  onText?: (reply: string, thinking: string) => void;
}

export async function askModel(modelId: string, prompt: string, onProgress: OnProgress = () => {}, opts: AskOptions = {}): Promise<string> {
  const signal = opts.signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT), opts.signal]) : AbortSignal.timeout(TIMEOUT);
  let tokens = 0, reply = "", thinking = "";
  const tick = (piece = "", thought = "") => {
    reply += piece; thinking += thought;
    onProgress(++tokens);
    opts.onText?.(reply, thinking);
  };

  if (modelId.startsWith("local|")) {
    const { kind, base, model } = parseModelId(modelId);
    if (kind === "ollama") {
      const chat = (noThink: boolean) => fetch(`${base}/api/chat`, {
        method: "POST", signal,
        body: JSON.stringify({ model, stream: true, format: "json", ...(noThink ? { think: false } : {}), messages: [{ role: "user", content: prompt }], options: { num_ctx: 16384, temperature: 0.4 } }),
      });
      // Thinking off where the model has it (much faster for a small task); models without it reject the option.
      let res = await chat(true);
      if (!res.ok) res = await chat(false);
      if (!res.ok) throw new Error(`Ollama: ${(await res.text()).slice(0, 300)}`);
      let text = "";
      for await (const line of lines(res.body)) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(`Ollama: ${ev.error}`);
        if (ev.message?.content) { text += ev.message.content; tick(ev.message.content); }
        else if (ev.message?.thinking) tick("", ev.message.thinking);
      }
      return text;
    }
    return openAiChat(`${base}/v1/chat/completions`, {}, model, prompt, signal, tick);
  }

  if (modelId.startsWith("api|")) {
    const { provider, model } = parseCloudId(modelId);
    const key = getKey(provider);
    if (!key) throw new Error(`No ${PROVIDERS[provider].name} API key.`);
    if (provider === "anthropic") {
      const stream = new Anthropic({ apiKey: key }).messages.stream({ model, max_tokens: 8000, messages: [{ role: "user", content: prompt }] }, { signal });
      stream.on("text", (t) => tick(t));
      const msg = await stream.finalMessage();
      return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }
    // OpenAI / OpenRouter: the Responses API, streamed.
    const res = await fetch(`${BASE[provider]}/responses`, {
      method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: prompt, stream: true }),
    });
    if (!res.ok) throw new Error(`${PROVIDERS[provider].name}: ${(await res.text()).slice(0, 300)}`);
    let text = "";
    for await (const line of lines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const ev = JSON.parse(data);
      if (ev.type === "response.output_text.delta" && ev.delta) { text += ev.delta; tick(ev.delta); }
      else if (ev.type === "response.reasoning_summary_text.delta" && ev.delta) tick("", ev.delta);
      if (ev.type === "response.completed" && !text) text = ev.response?.output_text || "";
    }
    return text;
  }
  return askClaudeCli(modelId, prompt, tick, signal);
}

/** An OpenAI-compatible chat endpoint (LM Studio, llama.cpp…), streamed. */
async function openAiChat(url: string, headers: Record<string, string>, model: string, prompt: string, signal: AbortSignal, tick: (piece?: string, thought?: string) => void) {
  const res = await fetch(url, {
    method: "POST", signal, headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, temperature: 0.4, stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`${url}: ${(await res.text()).slice(0, 300)}`);
  let text = "";
  for await (const line of lines(res.body)) {
    const data = line.replace(/^data:\s*/, "").trim();
    if (!data || data === "[DONE]" || !line.startsWith("data:")) continue;
    const delta = JSON.parse(data).choices?.[0]?.delta;
    const piece = delta?.content, thought = delta?.reasoning_content || delta?.reasoning;
    if (piece) { text += piece; tick(piece); }
    else if (typeof thought === "string" && thought) tick("", thought);
  }
  return text;
}

/** Through the Claude Code CLI (your plan), with no tools; streamed so the progress count moves. */
function askClaudeCli(model: string, prompt: string, tick: (piece?: string, thought?: string) => void, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const bin = findClaude();
    if (!bin) return reject(new Error("Could not find the claude CLI."));
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--no-session-persistence",
      ...(model && model !== "default" ? ["--model", model] : [])];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; // always the plan, never API billing
    const child = spawn(bin, args, { cwd: os.tmpdir(), windowsHide: true, env });
    let buf = "", err = "", result: string | null = null, failed = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude timed out")); }, TIMEOUT);
    signal.addEventListener("abort", () => { child.kill(); reject(new Error("Cancelled")); }, { once: true });
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          const delta = ev.type === "stream_event" ? ev.event?.delta : null;
          if (delta?.type === "text_delta") tick(delta.text || "");
          else if (delta?.type === "thinking_delta") tick("", delta.thinking || "");
          if (ev.type === "result") { if (ev.is_error) failed = ev.result || "error"; else result = String(ev.result || ""); }
        } catch { /* not JSON */ }
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (result != null) resolve(result);
      else reject(new Error(`Claude: ${(failed || err || `exit ${code}`).slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}
