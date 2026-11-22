// Settings → Local models: what Ollama has installed and running, downloading a model (in the background, with its
// progress, so it carries on when the settings are closed), cancelling, and deleting a model.
import { ensureOllama, gpuInfo, ollamaInstalled } from "../ai/ollama-start";
import { OLLAMA_URL } from "../ai/local-models";
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
  if (req.method === "GET" && path === "/api/ollama/pulls") { sendJson(res, 200, [...pulls.values()].map(pullView)); return; }
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
