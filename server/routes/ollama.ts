// Settings → Local models: what Ollama has installed and running, downloading a model (in the background, with its
// progress, so it carries on when the settings are closed), cancelling, and deleting a model. On Windows it can also
// install Ollama itself, by running the command ollama.com gives (elsewhere that command needs a terminal for sudo).
import { spawn } from "node:child_process";
import { ensureOllama, gpuInfo, ollamaInstalled } from "../ai/ollama-start";
import { OLLAMA_URL } from "../ai/local-models";
import { libraryTags, recommend, searchLibrary } from "../ai/ollama-library";
import { errMsg } from "../config";
import { type Req, type Res, lines, readJson, sendJson } from "../util/http";

interface Pull { name: string; status: string; total: number; completed: number; error?: string; done: boolean; started: number; abort: AbortController }
const pulls = new Map<string, Pull>();

const ollama = async (path: string, init?: RequestInit, ms = 4000) => {
  const res = await fetch(`${OLLAMA_URL}${path}`, { ...init, signal: init?.signal || AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`Ollama: ${(await res.text()).slice(0, 200)}`);
  return res;
};

/** Ollama's steps in plain words ("pulling 797b70c4edf8" is a download). */
const friendly = (status = "") =>
  /^pulling manifest/.test(status) ? "Getting ready…" : /^pulling /.test(status) ? "Downloading…" : /^verifying/.test(status) ? "Checking the download…"
  : /^(writing|removing)/.test(status) ? "Finishing…" : status === "success" ? "Installed" : status;

const pullView = (p: Pull) => ({ name: p.name, status: p.status, total: p.total, completed: p.completed, error: p.error, done: p.done, started: p.started });

/** Downloads a model with Ollama, keeping its progress (the biggest layer's bytes, as Ollama reports them). */
async function pull(name: string) {
  const p: Pull = { name, status: "Starting…", total: 0, completed: 0, done: false, started: Date.now(), abort: new AbortController() };
  pulls.set(name, p);
  try {
    const res = await ollama("/api/pull", { method: "POST", body: JSON.stringify({ model: name, stream: true }), signal: p.abort.signal });
    for await (const line of lines(res.body)) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.error) throw new Error(ev.error);
      p.status = friendly(ev.status) || p.status;
      if (ev.total) { p.total = ev.total; p.completed = ev.completed || 0; }
    }
    p.status = "Installed"; p.completed = p.total;
  } catch (e) {
    p.error = p.abort.signal.aborted ? "Cancelled" : errMsg(e).replace(/^Ollama: /, "");
  } finally {
    p.done = true;
    // Finished downloads drop off the list after a while.
    setTimeout(() => { if (pulls.get(name) === p) pulls.delete(name); }, 10 * 60_000).unref();
  }
}

/** The install command ollama.com shows for this system. */
export const INSTALL_COMMAND = process.platform === "win32" ? "irm https://ollama.com/install.ps1 | iex" : "curl -fsSL https://ollama.com/install.sh | sh";

interface Install { phase: "idle" | "running" | "done" | "error"; log: string[]; error: string; started: number }
const install: Install = { phase: "idle", log: [], error: "", started: 0 };

/** Runs Ollama's own Windows install command in the background (hidden window), keeping the last lines it prints. */
function installOllama() {
  if (install.phase === "running") return;
  Object.assign(install, { phase: "running", log: [], error: "", started: Date.now() });
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", INSTALL_COMMAND], { windowsHide: true });
  const keep = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) install.log.push(line.trim().slice(0, 300));
    install.log.splice(0, Math.max(0, install.log.length - 30));
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("error", (e) => { install.phase = "error"; install.error = errMsg(e); });
  child.on("close", async (code) => {
    if (install.phase !== "running") return;
    // Installed: start it (the installer usually does) and wait until it answers.
    if (code === 0 && (ollamaInstalled() || await ensureOllama())) { await ensureOllama(); install.phase = "done"; return; }
    install.phase = "error";
    install.error = code === 0 ? "The installer finished, but Ollama wasn't found. Try the download from ollama.com." : `The installer stopped (exit code ${code}).`;
  });
}

export async function handleOllama(req: Req, res: Res, path: string) {
  const body = req.method === "GET" ? null : await readJson(req);
  const name = String(body?.name || "").trim();
  if (req.method === "GET" && path === "/api/ollama") {
    const running = await ensureOllama();
    const [version, tags, ps, gpu]: [string, any, any, Awaited<ReturnType<typeof gpuInfo>>] = await Promise.all([
      running ? ollama("/api/version").then((r) => r.json()).then((j: any) => String(j.version || "")).catch(() => "") : "",
      running ? ollama("/api/tags").then((r) => r.json()).catch(() => ({ models: [] })) : { models: [] },
      running ? ollama("/api/ps").then((r) => r.json()).catch(() => ({ models: [] })) : { models: [] },
      gpuInfo(),
    ]);
    const loaded = new Set((ps.models || []).map((m: any) => m.name));
    sendJson(res, 200, {
      installed: ollamaInstalled() || running, running, version, gpu,
      models: (tags.models || []).map((m: any) => ({
        name: m.name, size: m.size, modified: m.modified_at, params: m.details?.parameter_size || "", quant: m.details?.quantization_level || "",
        loaded: loaded.has(m.name),
      })).sort((a: any, b: any) => a.name.localeCompare(b.name)),
      pulls: [...pulls.values()].map(pullView),
    });
    return;
  }
  if (path === "/api/ollama/install") {
    if (req.method === "POST") {
      if (process.platform !== "win32") { sendJson(res, 400, { error: `Run this in a terminal: ${INSTALL_COMMAND}` }); return; }
      installOllama();
    }
    sendJson(res, 200, { ...install, command: INSTALL_COMMAND, canRun: process.platform === "win32" });
    return;
  }
  if (req.method === "GET" && path === "/api/ollama/pulls") { sendJson(res, 200, [...pulls.values()].map(pullView)); return; }
  // The library on ollama.com: search, a model's sizes, and what fits this computer.
  if (req.method === "GET" && path === "/api/ollama/library") {
    const q = new URL(req.url || "/", "http://x").searchParams;
    try { sendJson(res, 200, await searchLibrary(String(q.get("q") || "").slice(0, 60), String(q.get("cap") || "").replace(/[^a-z]/g, ""))); }
    catch (e) { sendJson(res, 502, { error: errMsg(e) }); }
    return;
  }
  if (req.method === "GET" && path === "/api/ollama/tags") {
    const model = String(new URL(req.url || "/", "http://x").searchParams.get("model") || "");
    if (!/^[\w.\-/]{1,80}$/.test(model)) { sendJson(res, 400, { error: "That isn't a model name." }); return; }
    try { sendJson(res, 200, await libraryTags(model)); } catch (e) { sendJson(res, 502, { error: errMsg(e) }); }
    return;
  }
  if (req.method === "GET" && path === "/api/ollama/recommend") {
    const gpu = await gpuInfo();
    if (!gpu) { sendJson(res, 200, { gpu: null, models: [] }); return; }
    try { sendJson(res, 200, { gpu, models: await recommend(gpu.memGb, gpu.unified) }); } catch (e) { sendJson(res, 502, { error: errMsg(e) }); }
    return;
  }
  // Model names as Ollama writes them: "qwen3.5:9b", "library/model:tag", "hf.co/user/repo:Q4_K_M".
  if (!/^[\w.\-/:]{1,120}$/.test(name)) { sendJson(res, 400, { error: "That isn't a model name." }); return; }
  if (req.method === "POST" && path === "/api/ollama/pull") {
    if (!(await ensureOllama())) { sendJson(res, 409, { error: "Ollama isn't running. Install or start it first." }); return; }
    const now = pulls.get(name);
    if (!now || now.done) pull(name);
    sendJson(res, 202, pullView(pulls.get(name)!));
    return;
  }
  if (req.method === "POST" && path === "/api/ollama/cancel") { pulls.get(name)?.abort.abort(); sendJson(res, 200, { ok: true }); return; }
  if (req.method === "DELETE" && path === "/api/ollama/model") {
    try { await ollama("/api/delete", { method: "DELETE", body: JSON.stringify({ model: name }) }, 20000); sendJson(res, 200, { ok: true }); }
    catch (e) { sendJson(res, 500, { error: errMsg(e) }); }
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}
