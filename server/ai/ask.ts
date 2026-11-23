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
import { keepAlive, readSettings, tune } from "../settings";
import { loopGuard } from "./loop-guard";
import { BASE } from "./responses";

const TIMEOUT = 6 * 60_000;

/** The longest context each Ollama model was trained for (from /api/show), asked once per model. */
const modelMax = new Map<string, number>();
async function ollamaMaxCtx(base: string, model: string) {
  const key = `${base}|${model}`;
  if (!modelMax.has(key)) {
    try {
      const info: any = await (await fetch(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) })).json();
      modelMax.set(key, Number(Object.entries(info.model_info || {}).find(([k]) => k.endsWith(".context_length"))?.[1]) || 0);
    } catch { modelMax.set(key, 0); }
  }
  return modelMax.get(key)!;
}

/**
 * The context window for a one-off question: room for the prompt (about 3 characters a token), the pictures, the
 * thinking and the answer. A fixed 16k cut the trip chat off: with a long itinerary in the prompt Ollama dropped the
 * start of it and stopped the answer after a few hundred tokens once the window was full.
 */
async function askCtx(base: string, model: string, prompt: string, images: number, thinks: boolean) {
  const fixed = readSettings().numCtx, max = await ollamaMaxCtx(base, model);
  const cap = Math.min(fixed || Number(process.env.OLLAMA_NUM_CTX) || 131072, max || 131072);
  const needed = Math.ceil(prompt.length / 3) + images * 1600 + (thinks ? 12000 : 4000);
  return Math.max(Math.min(16384, cap), Math.min(cap, Math.ceil(needed / 4096) * 4096));
}
export type OnProgress = (tokens: number) => void;
export interface AskOptions {
  signal?: AbortSignal;
  /** The reply so far and the model's own thinking so far (where it shows any). */
  onText?: (reply: string, thinking: string) => void;
  /** Told when the model got stuck repeating itself and is asked once more. */
  onRetry?: (message: string) => void;
  /** What's added to the prompt when it's asked once more (default: answer with the JSON right away). */
  nudge?: string;
  /** A plain-text answer (the trip chat) instead of JSON: Ollama isn't held to JSON, and thinks as set in Settings. */
  text?: boolean;
  /** Pictures to look at (the trip chat), base64 without the "data:" prefix. Models that can't see them say so. */
  images?: AskImage[];
}
export interface AskImage { type: string; data: string }
const dataUrl = (i: AskImage) => `data:${i.type};base64,${i.data}`;

/**
 * Asks, watching for the model going round in circles (the same block of thinking over and over until it runs out of
 * time): then it's stopped and asked once more, more directly and with settings against repeating; a second loop ends
 * with an error instead of minutes of spinning.
 */
export async function askModel(modelId: string, prompt: string, onProgress: OnProgress = () => {}, opts: AskOptions = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const loop = new AbortController(), looping = loopGuard();
    const signal = opts.signal ? AbortSignal.any([opts.signal, loop.signal]) : loop.signal;
    const asked = attempt ? `${prompt}\n\n${opts.nudge || "Answer with the JSON right away."} Keep any thinking short and don't go over the same points again.` : prompt;
    try {
      return await askOnce(modelId, asked, onProgress, { ...opts, signal }, attempt > 0, (piece) => { if (piece && looping(piece)) loop.abort(new Error("loop")); });
    } catch (e) {
      if (!loop.signal.aborted || opts.signal?.aborted) throw e;
      if (attempt) throw new Error("The model kept going round in circles instead of answering, even when asked again. Try again, or pick a different model.");
      opts.onRetry?.("The model got stuck repeating itself; asking again, more directly…");
    }
  }
}

async function askOnce(modelId: string, prompt: string, onProgress: OnProgress, opts: AskOptions, retry: boolean, onPiece: (piece: string) => void): Promise<string> {
  const signal = opts.signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT), opts.signal]) : AbortSignal.timeout(TIMEOUT);
  let tokens = 0, reply = "", thinking = "";
  const tick = (piece = "", thought = "") => {
    reply += piece; thinking += thought;
    onProgress(++tokens);
    opts.onText?.(reply, thinking);
    onPiece(piece || thought);
  };

  if (modelId.startsWith("local|")) {
    const { kind, base, model } = parseModelId(modelId);
    if (kind === "ollama") {
      const images = opts.images?.length ? { images: opts.images.map((i) => i.data) } : {};
      const numCtx = await askCtx(base, model, prompt, opts.images?.length || 0, !!opts.text && tune().thinking !== "off");
      const chat = (noThink: boolean) => fetch(`${base}/api/chat`, {
        method: "POST", signal,
        body: JSON.stringify({
          model, stream: true, ...(opts.text ? {} : { format: "json" }), ...(noThink ? { think: false } : {}), messages: [{ role: "user", content: prompt, ...images }],
          // Asked again after a loop: a little more randomness and a penalty on repeating, to get it out of the rut.
          options: { num_ctx: numCtx, temperature: retry ? Math.min(1, tune().temperature + 0.3) : tune().temperature, ...(retry ? { repeat_penalty: 1.15 } : {}) },
          keep_alive: keepAlive(tune().keepAlive),
        }),
      });
      // Thinking off where the model has it (much faster for a small task; the chat thinks as set in Settings); models
      // without it reject the option.
      let res = await chat(!opts.text || tune().thinking === "off");
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
    return openAiChat(`${base}/v1/chat/completions`, {}, model, prompt, signal, tick, retry, opts.images);
  }

  if (modelId.startsWith("api|")) {
    const { provider, model } = parseCloudId(modelId);
    const key = getKey(provider);
    if (!key) throw new Error(`No ${PROVIDERS[provider].name} API key.`);
    if (provider === "anthropic") {
      const content = opts.images?.length
        ? [...opts.images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.type as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: i.data } })), { type: "text" as const, text: prompt }]
        : prompt;
      const stream = new Anthropic({ apiKey: key }).messages.stream({ model, max_tokens: 8000, messages: [{ role: "user", content }] }, { signal });
      stream.on("text", (t) => tick(t));
      const msg = await stream.finalMessage();
      return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }
    // OpenAI / OpenRouter: the Responses API, streamed.
    const res = await fetch(`${BASE[provider]}/responses`, {
      method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, stream: true, input: opts.images?.length
        ? [{ role: "user", content: [{ type: "input_text", text: prompt }, ...opts.images.map((i) => ({ type: "input_image", image_url: dataUrl(i) }))] }]
        : prompt }),
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
  return askClaudeCli(modelId, prompt, tick, signal, opts.images);
}

/** An OpenAI-compatible chat endpoint (LM Studio, llama.cpp…), streamed. */
async function openAiChat(url: string, headers: Record<string, string>, model: string, prompt: string, signal: AbortSignal, tick: (piece?: string, thought?: string) => void, retry = false, images?: AskImage[]) {
  const content = images?.length ? [{ type: "text", text: prompt }, ...images.map((i) => ({ type: "image_url", image_url: { url: dataUrl(i) } }))] : prompt;
  const res = await fetch(url, {
    method: "POST", signal, headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, temperature: retry ? Math.min(1, tune().temperature + 0.3) : tune().temperature, ...(retry ? { frequency_penalty: 0.3 } : {}), stream: true, messages: [{ role: "user", content }] }),
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
function askClaudeCli(model: string, prompt: string, tick: (piece?: string, thought?: string) => void, signal: AbortSignal, images?: AskImage[]) {
  return new Promise<string>((resolve, reject) => {
    const bin = findClaude();
    if (!bin) return reject(new Error("Could not find the claude CLI."));
    // With pictures, the message goes in as stream-json (text and image blocks); otherwise as plain text.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--no-session-persistence",
      ...(images?.length ? ["--input-format", "stream-json"] : []), ...(model && model !== "default" ? ["--model", model] : [])];
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
    child.stdin.end(images?.length
      ? `${JSON.stringify({ type: "user", message: { role: "user", content: [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.type, data: i.data } })), { type: "text", text: prompt }] } })}\n`
      : prompt);
  });
}
