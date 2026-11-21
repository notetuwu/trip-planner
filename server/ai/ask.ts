// A short one-off question to whichever model is selected (no tools, no streaming), for small helper tasks such as
// picking stops along a route. Answers are expected as JSON in the reply text.
import { spawn } from "node:child_process";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { getKey, PROVIDERS } from "../keys";
import { findClaude } from "./claude-bin";
import { parseCloudId } from "./cloud-models";
import { parseModelId } from "./local-models";
import { BASE } from "./responses";

const TIMEOUT = 4 * 60_000;

export async function askModel(modelId: string, prompt: string): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT);
  if (modelId.startsWith("local|")) {
    const { kind, base, model } = parseModelId(modelId);
    if (kind === "ollama") {
      const chat = (noThink: boolean) => fetch(`${base}/api/chat`, {
        method: "POST", signal,
        body: JSON.stringify({ model, stream: false, format: "json", ...(noThink ? { think: false } : {}), messages: [{ role: "user", content: prompt }], options: { num_ctx: 16384, temperature: 0.4 } }),
      });
      // Thinking off where the model has it (much faster for a small task); models without it reject the option.
      let res = await chat(true);
      if (!res.ok) res = await chat(false);
      if (!res.ok) throw new Error(`Ollama: ${(await res.text()).slice(0, 300)}`);
      return ((await res.json()) as any).message?.content || "";
    }
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.4, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`${base}: ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as any).choices?.[0]?.message?.content || "";
  }
  if (modelId.startsWith("api|")) {
    const { provider, model } = parseCloudId(modelId);
    const key = getKey(provider);
    if (!key) throw new Error(`No ${PROVIDERS[provider].name} API key.`);
    if (provider === "anthropic") {
      const msg = await new Anthropic({ apiKey: key }).messages.create({ model, max_tokens: 4000, messages: [{ role: "user", content: prompt }] }, { signal });
      return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }
    const res = await fetch(`${BASE[provider]}/responses`, {
      method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: prompt }),
    });
    if (!res.ok) throw new Error(`${PROVIDERS[provider].name}: ${(await res.text()).slice(0, 300)}`);
    const out: any = await res.json();
    return out.output_text || (out.output || []).flatMap((o: any) => o.content || []).map((c: any) => c.text || "").join("");
  }
  return askClaudeCli(modelId, prompt);
}

/** Through the Claude Code CLI (your plan), with no tools. */
function askClaudeCli(model: string, prompt: string) {
  return new Promise<string>((resolve, reject) => {
    const bin = findClaude();
    if (!bin) return reject(new Error("Could not find the claude CLI."));
    const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", ...(model && model !== "default" ? ["--model", model] : [])];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; // always the plan, never API billing
    const child = spawn(bin, args, { cwd: os.tmpdir(), windowsHide: true, env });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude timed out")); }, TIMEOUT);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try { const j = JSON.parse(out); if (j.is_error) throw new Error(j.result || "error"); resolve(String(j.result || "")); }
      catch (e) { reject(new Error(`Claude: ${(err || out || (e as Error).message).slice(0, 300)} (exit ${code})`)); }
    });
    child.stdin.end(prompt);
  });
}
