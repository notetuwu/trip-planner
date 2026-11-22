// Settings: General (how the app opens, theme, API keys, where the data is), Local models (Ollama: status, the graphics
// card, models that fit it with one-click installs and download progress, installed models, the context size), and
// Phone (the planner on the home network for a phone: start/stop, status, the link and its QR code).
import qrcode from "qrcode-generator";
import type { GpuInfo } from "../../../shared/types";
import { $, $$, api, esc, toast } from "../core/dom";
import { ext, icon } from "../core/icons";
import { type Choice, choice, setTheme } from "../core/theme";
import { openKeys } from "../generate/keys";
import { MODELS, suggestion } from "../generate/local-guide";
import { refreshModels } from "../generate/models";

interface Settings { window: "app" | "browser"; numCtx: number; lan: boolean; packaged: boolean; appWindow: boolean; dataDir: string; version: string }
interface Pull { name: string; status: string; total: number; completed: number; error?: string; done: boolean; started: number }
interface OllamaModel { name: string; size: number; params: string; quant: string; loaded: boolean }
interface OllamaInfo { installed: boolean; running: boolean; version: string; gpu: GpuInfo | null; models: OllamaModel[]; pulls: Pull[] }
interface LanStatus { running: boolean; port: number; since: number; error: string; urls: string[] }

type Tab = "general" | "models" | "phone";
let tab: Tab = "general", settings: Settings | null = null, ollama: OllamaInfo | null = null, lan: LanStatus | null = null;
let poll: number | undefined, loadError = "";

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes > 10 * 1024 ** 3 ? 0 : 1)} GB`;
const dialog = () => $<HTMLDialogElement>("#settingsDialog");

export async function openSettings(which: Tab = tab) {
  tab = which;
  dialog().showModal();
  render();
  await load();
}

async function load() {
  loadError = "";
  try {
    [settings, lan] = await Promise.all([api<Settings>("/api/settings"), api<LanStatus>("/api/lan")]);
  } catch (e) {
    // A phone on the home network can't change the computer's settings.
    loadError = (e as Error).message;
  }
  render();
  if (tab === "models") await loadOllama();
}

async function loadOllama() {
  try { ollama = await api<OllamaInfo>("/api/ollama"); } catch { ollama = null; }
  render();
  watchPulls();
}

/** While something downloads (and the settings are open), check its progress every second. */
function watchPulls() {
  clearInterval(poll);
  if (!ollama?.pulls.some((p) => !p.done)) return;
  poll = window.setInterval(async () => {
    if (!dialog().open) return clearInterval(poll);
    const pulls = await api<Pull[]>("/api/ollama/pulls").catch(() => null);
    if (!pulls || !ollama) return;
    const finished = ollama.pulls.filter((p) => !p.done).some((p) => pulls.find((q) => q.name === p.name)?.done);
    ollama.pulls = pulls;
    if (finished) { await loadOllama(); refreshModels(); return; } // new model: the model menu shows it too
    renderModels();
  }, 1000);
}

// ---- Rendering ----

function render() {
  const nav = (t: Tab, ico: Parameters<typeof icon>[0], label: string) =>
    `<button type="button" class="set-tab${tab === t ? " on" : ""}" data-tab="${t}">${icon(ico)}<span>${label}</span></button>`;
  $("#settingsBody").innerHTML = `
    <nav class="set-nav">${nav("general", "sliders", "General")}${nav("models", "cpu", "Local models")}${nav("phone", "phone", "Phone")}</nav>
    <div class="set-main" id="setMain"></div>`;
  $$<HTMLButtonElement>("#settingsBody [data-tab]").forEach((b) => { b.onclick = () => { tab = b.dataset.tab as Tab; render(); if (tab === "models" && !ollama) loadOllama(); }; });
  if (loadError) { $("#setMain").innerHTML = `<p class="hint">${esc(loadError)}</p>`; return; }
  if (tab === "general") renderGeneral();
  else if (tab === "models") renderModels();
  else renderPhone();
}

function renderGeneral() {
  const s = settings, th = choice();
  const seg = (c: Choice, label: string) => `<button type="button" class="seg${th === c ? " on" : ""}" data-theme-choice="${c}">${label}</button>`;
  $("#setMain").innerHTML = `
    <h3>General</h3>
    <div class="set-card">
      ${s?.packaged && s.appWindow ? `<div class="set-row"><div><b>Opens in</b><div class="hint">How the planner opens when you start it.</div></div>
        <select id="setWindow"><option value="app">Its own window</option><option value="browser">A browser tab</option></select></div>` : ""}
      <div class="set-row"><div><b>Theme</b><div class="hint">Light, dark, or following your system.</div></div>
        <div class="segs">${seg("system", "System")}${seg("light", "Light")}${seg("dark", "Dark")}</div></div>
      <div class="set-row"><div><b>API keys</b><div class="hint">Anthropic, OpenAI or OpenRouter, for planning with a paid account.</div></div>
        <button type="button" class="btn" id="setKeys">${icon("key")} Manage keys</button></div>
    </div>
    <div class="set-card">
      <div class="set-row"><div><b>Your data</b><div class="hint">Saved trips, place lists, caches and settings live in this folder on your computer.</div>
        <code class="set-path">${esc(s?.dataDir || "")}</code></div>
        <button type="button" class="btn" id="setCopyPath">${icon("copy")} Copy</button></div>
      <div class="set-row"><div><b>Version</b><div class="hint">Trip Planner ${esc(s?.version || "")}. Updates are offered automatically.</div></div>
        <a class="btn" href="https://github.com/notetuwu/trip-planner/releases" target="_blank" rel="noopener">What's new${ext()}</a></div>
    </div>`;
  const win = document.querySelector<HTMLSelectElement>("#setWindow");
  if (win && s) {
    win.value = s.window;
    win.onchange = async () => { settings = await api<Settings>("/api/settings", { method: "POST", body: JSON.stringify({ window: win.value }) }); toast("Saved: it opens that way from the next start"); };
  }
  $$<HTMLButtonElement>("[data-theme-choice]").forEach((b) => { b.onclick = () => { setTheme(b.dataset.themeChoice as Choice); renderGeneral(); }; });
  $("#setKeys").onclick = () => openKeys(() => { refreshModels(); });
  $("#setCopyPath").onclick = () => navigator.clipboard.writeText(s?.dataDir || "").then(() => toast("Copied the folder path"));
}

function renderModels() {
  const main = document.querySelector<HTMLElement>("#setMain");
  if (!main || tab !== "models") return;
  const o = ollama, gpu = o?.gpu || null, pick = suggestion(gpu);
  const installed = new Set((o?.models || []).map((m) => m.name));
  const pullOf = (name: string) => o?.pulls.find((p) => p.name === name);
  const status = !o ? `<span class="dot"></span> Checking…`
    : o.running ? `<span class="dot ok"></span> Ollama is running${o.version ? ` <span class="hint">· version ${esc(o.version)}</span>` : ""}`
    : o.installed ? `<span class="dot warn"></span> Ollama is installed but not running`
    : `<span class="dot off"></span> Ollama isn't installed`;
  // How well a model fits the graphics card: comfortably, just (it'll be slower with long trips), or not at all.
  const usable = gpu ? (gpu.unified ? gpu.memGb * 0.65 : gpu.memGb) : 0;
  const fit = (need: number) => !gpu ? "" : need <= usable ? `<span class="fit ok">Fits your GPU</span>` : need <= usable * 1.35 ? `<span class="fit warn">Tight</span>` : `<span class="fit bad">Too big for your GPU</span>`;
  const progress = (p: Pull) => {
    const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
    const secs = (Date.now() - p.started) / 1000, rate = secs > 2 && p.completed ? p.completed / secs : 0;
    return p.error ? `<div class="pull err">${icon("warn")} ${esc(p.error)}</div>`
      : p.done ? `<div class="pull ok">${icon("check")} Installed</div>`
      : `<div class="pull"><div class="bar"><i style="width:${pct}%"></i></div>
          <div class="hint">${esc(p.status)}${p.total ? ` · ${gb(p.completed)} of ${gb(p.total)} (${pct}%)` : ""}${rate ? ` · ${(rate / 1024 ** 2).toFixed(0)} MB/s` : ""}
          <button type="button" class="link-btn" data-cancel="${esc(p.name)}">Cancel</button></div></div>`;
  };
  const action = (name: string) => {
    const p = pullOf(name);
    if (p && (!p.done || p.error)) return progress(p);
    if (installed.has(name)) return `<span class="ok-text">${icon("check")} Installed</span>`;
    // The same model under another tag ("qwen3.8:latest" for "qwen3.8:27b") is probably what they have already.
    const like = (o?.models || []).find((m) => m.name.split(":")[0] === name.split(":")[0]);
    return `${like ? `<span class="hint have">You have ${esc(like.name)}</span>` : ""}<button type="button" class="btn" data-pull="${esc(name)}" ${o?.running ? "" : "disabled"}>${icon("download")} Install</button>`;
  };
  const recs = MODELS.map((m) => `
    <div class="model-row${pick?.tag === m.tag ? " pick" : ""}">
      <div class="m-name"><code>${m.tag}</code>${pick?.tag === m.tag ? ` <span class="pick-badge">best for your GPU</span>` : ""} ${fit(m.need)}
        <div class="hint">${esc(m.note)} · ${m.size.toFixed(1)} GB download</div></div>
      <div class="m-act">${action(m.tag)}</div>
    </div>`).join("");
  // Downloads of models that aren't in the list above (typed in), and the installed models.
  const others = (o?.pulls || []).filter((p) => !MODELS.some((m) => m.tag === p.name) && (!p.done || p.error));
  const mine = (o?.models || []).map((m) => `
    <div class="model-row">
      <div class="m-name"><code>${esc(m.name)}</code>${m.loaded ? ` <span class="fit ok">in memory</span>` : ""}
        <div class="hint">${[m.params, m.quant, gb(m.size)].filter(Boolean).map(esc).join(" · ")}</div></div>
      <div class="m-act"><button type="button" class="icon-btn" data-delete="${esc(m.name)}" title="Delete this model (frees ${gb(m.size)})">${icon("trash")}</button></div>
    </div>`).join("");
  const ctxOpts = [[0, "Automatic (as much as the trip needs)"], [16384, "16k tokens"], [32768, "32k tokens"], [65536, "64k tokens"], [131072, "128k tokens"], [196608, "192k tokens"], [262144, "256k tokens"]] as const;
  main.innerHTML = `
    <h3>Local models <button type="button" class="icon-btn" id="setRefresh" title="Check again">${icon("refresh")}</button></h3>
    <div class="set-card">
      <div class="set-row"><div><b class="status">${status}</b>
        <div class="hint">${o?.running ? "Models run on your own computer: free and private." : o?.installed ? "The planner tries to start it; you can also open Ollama from the Start menu (or Applications on a Mac)." : "Ollama runs AI models on your own computer. Install it, then come back here to add a model."}</div></div>
        ${o && !o.installed ? `<a class="btn solid" href="https://ollama.com/download" target="_blank" rel="noopener">Download Ollama${ext()}</a>` : ""}</div>
      <div class="set-row"><div><b>${icon("cpu")} Graphics card</b><div class="hint">${gpu ? `${esc(gpu.name)} · ${gpu.memGb} GB${gpu.unified ? " shared memory" : ""}` : "Not detected (an NVIDIA card is read with nvidia-smi). Models still run, more slowly, on the processor."}</div></div></div>
    </div>
    <div class="set-card">
      <b class="card-title">Recommended</b>
      <p class="hint">${gpu ? `Picked for ${gpu.memGb} GB of graphics memory, with room for the planner's long prompts.` : "Bigger models plan better but need more graphics memory."}</p>
      ${recs}
      <div class="pull-other"><input id="setPullName" placeholder="Any other model from ollama.com/library, e.g. llama3.3:70b"><button type="button" class="btn" id="setPullGo" ${o?.running ? "" : "disabled"}>${icon("download")} Install</button></div>
      ${others.map((p) => `<div class="model-row"><div class="m-name"><code>${esc(p.name)}</code></div><div class="m-act">${progress(p)}</div></div>`).join("")}
    </div>
    <div class="set-card">
      <b class="card-title">Installed</b>
      ${mine || `<p class="hint">${o?.running ? "No models yet. Install one above." : "—"}</p>`}
    </div>
    <div class="set-card">
      <div class="set-row"><div><b>Context size</b><div class="hint">How much a local model can read and write at once. Automatic sizes it for each trip; a fixed size uses that much every time (more needs more graphics memory, and the model's own limit still applies).</div></div>
        <select id="setCtx">${ctxOpts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
    </div>`;
  $("#setRefresh").onclick = () => loadOllama();
  const ctx = $<HTMLSelectElement>("#setCtx");
  ctx.value = String(settings?.numCtx || 0);
  ctx.onchange = async () => { settings = await api<Settings>("/api/settings", { method: "POST", body: JSON.stringify({ numCtx: +ctx.value }) }); toast("Saved: used for the next plan"); };
  const startPull = async (name: string) => {
    try { await api("/api/ollama/pull", { method: "POST", body: JSON.stringify({ name }) }); await loadOllama(); }
    catch (e) { toast((e as Error).message); }
  };
  $$<HTMLButtonElement>("#setMain [data-pull]").forEach((b) => { b.onclick = () => startPull(b.dataset.pull!); });
  $("#setPullGo").onclick = () => { const n = $<HTMLInputElement>("#setPullName").value.trim(); if (n) startPull(n); };
  $<HTMLInputElement>("#setPullName").onkeydown = (e) => { if (e.key === "Enter") $("#setPullGo").click(); };
  $$<HTMLButtonElement>("#setMain [data-cancel]").forEach((b) => { b.onclick = () => api("/api/ollama/cancel", { method: "POST", body: JSON.stringify({ name: b.dataset.cancel }) }); });
  $$<HTMLButtonElement>("#setMain [data-delete]").forEach((b) => {
    b.onclick = async () => {
      const name = b.dataset.delete!;
      if (!confirm(`Delete ${name} from this computer? You can install it again later.`)) return;
      try { await api("/api/ollama/model", { method: "DELETE", body: JSON.stringify({ name }) }); toast(`Deleted ${name}`); await loadOllama(); refreshModels(); }
      catch (e) { toast((e as Error).message); }
    };
  });
}

function renderPhone() {
  const l = lan, url = l?.urls[0] || "";
  let qr = "";
  if (url) { const q = qrcode(0, "M"); q.addData(url); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
  const since = l?.since ? new Date(l.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  $("#setMain").innerHTML = `
    <h3>Phone</h3>
    <div class="set-card">
      <div class="set-row"><div><b class="status">${l?.running ? `<span class="dot ok"></span> Phone access is on <span class="hint">· since ${esc(since)}</span>` : `<span class="dot off"></span> Phone access is off`}</b>
        <div class="hint">Use the planner on your phone while it runs here: on the same Wi-Fi, open the link or scan the code.</div></div>
        <button type="button" class="btn ${l?.running ? "" : "solid"}" id="setLan">${icon("power")} ${l?.running ? "Stop" : "Start"}</button></div>
      ${l?.error ? `<p class="error-text">${icon("warn")} ${esc(l.error)}</p>` : ""}
      ${l?.running ? (url ? `
        <div class="phone-link">
          <div class="qr">${qr}</div>
          <div>
            <b>Scan with your phone's camera</b>
            <p class="hint">Or open this link on the phone. It holds a secret, so only devices you give it to get in.</p>
            ${l.urls.map((u) => `<div class="link-row"><code>${esc(u)}</code><button type="button" class="icon-btn" data-copy="${esc(u)}" title="Copy">${icon("copy")}</button></div>`).join("")}
            <button type="button" class="link-btn" id="setNewLink">New link (phones with the old one have to scan again)</button>
          </div>
        </div>` : `<p class="hint">${icon("warn")} No home network found. Connect this computer to Wi-Fi or a cable.</p>`) : ""}
    </div>
    <div class="set-card">
      <b class="card-title">Good to know</b>
      <ul class="set-list">
        <li>The phone uses this computer: the same saved trips, place lists and models, and the trip you have open. Switch between them and the other one catches up.</li>
        <li>The computer has to stay on with the planner running. Phone access starts again with the planner while it's on.</li>
        <li>Windows may ask whether Trip Planner may use the network: allow it for <b>private networks</b>.</li>
        <li>API keys, updates, settings and model downloads stay on the computer.</li>
      </ul>
    </div>`;
  $("#setLan").onclick = async () => {
    lan = await api<LanStatus>("/api/lan", { method: "POST", body: JSON.stringify({ on: !l?.running }) });
    renderPhone();
  };
  document.querySelector<HTMLButtonElement>("#setNewLink")?.addEventListener("click", async () => {
    if (!confirm("Make a new link? Phones that used the old one have to open the new one.")) return;
    lan = await api<LanStatus>("/api/lan/new-link", { method: "POST" });
    renderPhone();
  });
  $$<HTMLButtonElement>("#setMain [data-copy]").forEach((b) => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy!).then(() => toast("Copied the link")); });
}

export function initSettings() {
  $("#settingsBtn").onclick = () => openSettings();
}
