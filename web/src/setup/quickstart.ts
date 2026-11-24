// The quick-start guide (the rocket next to Settings; it opens by itself the first time the app starts): what's set
// up on this computer and what's missing, in sections: a model to plan with (Claude Code, API keys, local models with
// Ollama), web research for local models (the search engine, a Brave key, Docker and SearXNG), making it yours (the
// settings worth a look) and the first trip. Each check shows its status; what's missing links to where it's set up.
import type { CloudProvider, KeyStatus } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { ext, icon } from "../core/icons";
import { renderKeyRows } from "../generate/keys";
import { refreshModels } from "../generate/models";
import { type ServiceKey, openSettings, serviceKeyField, wireServiceKeys } from "../settings/settings";
import { type SearxngInfo, mountSearxng } from "../settings/searxng-panel";
import { SEARXNG_LOCAL } from "../settings/searxng-local";

interface Setup {
  claude: boolean;
  keys: Record<CloudProvider, KeyStatus>;
  ollama: { installed: boolean; running: boolean };
  localModels: number;
  search: "auto" | "brave" | "searxng";
  braveKey: boolean;
  searxngUrl: string;
  searxng: SearxngInfo;
}

type Mark = "ok" | "warn" | "off" | "wait";
let setup: Setup | null = null, loading = false, error = "";
/** The Brave, Geoapify and Google keys: set or not, and their last characters. */
let serviceKeys: Partial<Record<ServiceKey, KeyStatus>> = {};
/** The sections slide in and the ticks pop once, when the first answers arrive after opening (not on every redraw). */
let animated = false;
const dialog = () => $<HTMLDialogElement>("#quickstartDialog");

const anyKey = (s: Setup) => Object.values(s.keys || {}).some((k) => k?.set);
const canPlan = (s: Setup) => s.claude || anyKey(s) || s.localModels > 0;
/** Research for local models is good: Brave with a key, or SearXNG answering (here, or their own server). */
const researchReady = (s: Setup) => (s.search === "brave" && s.braveKey)
  || (s.search !== "brave" && !!s.searxngUrl && (s.searxngUrl !== SEARXNG_LOCAL || (s.searxng.running && s.searxng.linked)));

const chip = (m: Mark, text: string) => `<span class="qs-chip ${m}">${m === "wait" ? `<span class="sx-spin small"></span>` : m === "ok"
  ? `<svg class="sx-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>` : m === "warn" ? icon("warn") : icon("x")}${esc(text)}</span>`;

/** The five things checked, as a row of ticks at the top. */
function checklist(s: Setup | null) {
  const items: [string, Parameters<typeof icon>[0], Mark, string][] = s ? [
    ["Claude Code", "terminal", s.claude ? "ok" : "off", s.claude ? "Found" : "Not found"],
    ["API keys", "key", anyKey(s) ? "ok" : "off", anyKey(s) ? `${Object.values(s.keys).filter((k) => k?.set).length} set` : "None"],
    ["Ollama", "cpu", s.localModels ? "ok" : s.ollama.installed ? "warn" : "off", s.localModels ? `${s.localModels} model${s.localModels > 1 ? "s" : ""}` : s.ollama.running ? "No model yet" : s.ollama.installed ? "Not running" : "Not installed"],
    ["Docker", "container", s.searxng.docker === "ok" ? "ok" : s.searxng.docker === "stopped" ? "warn" : "off", s.searxng.docker === "ok" ? "Running" : s.searxng.docker === "stopped" ? "Not running" : "Not installed"],
    ["SearXNG", "search", s.searxng.running ? "ok" : s.searxng.installed ? "warn" : "off", s.searxng.running ? (s.searxng.linked ? "Running" : "Unused") : s.searxng.installed ? "Stopped" : "Not set up"],
  ] : ["Claude Code", "API keys", "Ollama", "Docker", "SearXNG"].map((n, i) => [n, (["terminal", "key", "cpu", "container", "search"] as const)[i], "wait", "Checking…"]);
  return `<ul class="qs-checks">${items.map(([name, ico, m, text], i) => `<li class="qs-check ${m}" style="--i:${i}">
      <span class="qs-check-icon">${icon(ico)}</span><span class="qs-check-text"><b>${name}</b>${chip(m, text)}</span></li>`).join("")}</ul>`;
}

function hero(s: Setup | null) {
  const ready = !!s && canPlan(s);
  const title = !s ? "Checking this computer…" : ready ? "You're ready to plan" : "One thing left: a model to plan with";
  const sub = !s ? "Looking for Claude Code, API keys, Ollama, Docker and SearXNG."
    : ready ? (researchReady(s) || !s.localModels ? "Everything that's needed is here. The rest below is optional, to make it even better."
      : "Local models plan best with a proper web search: set one up under Web research below.")
    : "Pick one of the three ways below: Claude Code, an API key, or a free local model.";
  return `<div class="qs-hero${ready ? " ready" : ""}">
    <div class="qs-badge-big">${!s ? `<span class="qs-rocket">${icon("rocket")}</span>` : ready ? `<svg class="sx-check big" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>` : icon("compass")}</div>
    <div><h2>${title}</h2><p>${sub}</p></div>
  </div>${checklist(s)}`;
}

const section = (n: number, title: string, intro: string, badge: string, body: string) => `
  <section class="qs-sec" style="--i:${n}">
    <header class="qs-sec-head"><span class="qs-num">${n}</span><div><h3>${title}</h3><p>${intro}</p></div>${badge}</header>
    ${body}
  </section>`;

function modelSection(s: Setup) {
  const ollama = !s.ollama.installed ? { m: "off" as Mark, t: "Not installed", btn: `<button type="button" class="btn solid" data-settings="models">${icon("download")} Install Ollama</button>` }
    : !s.ollama.running ? { m: "warn" as Mark, t: "Installed, not running", btn: `<button type="button" class="btn" data-settings="models">${icon("power")} Start it in Settings</button>` }
    : !s.localModels ? { m: "warn" as Mark, t: "Running, no model yet", btn: `<button type="button" class="btn solid" data-settings="models">${icon("download")} Pick a model for your GPU</button>` }
    : { m: "ok" as Mark, t: `${s.localModels} model${s.localModels > 1 ? "s" : ""} ready`, btn: `<button type="button" class="btn" data-settings="models">Manage models</button>` };
  const body = `<div class="qs-options">
    <article class="qs-opt${s.claude ? " on" : ""}">
      <div class="qs-opt-head"><span class="qs-opt-icon">${icon("terminal")}</span><b>Claude Code</b>${chip(s.claude ? "ok" : "off", s.claude ? "Found" : "Not found")}</div>
      <p>The best plans. Uses your Claude subscription (Pro or Max), no key needed, and searches the web by itself.</p>
      ${s.claude ? `<p class="hint">Pick a Claude model in the Model menu under Planning.</p>`
        : `<p class="hint">Install it, sign in once by running <code>claude</code> in a terminal, then check again here.</p>
           <div class="qs-acts"><a class="btn solid" href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noopener">${icon("download")} How to install${ext()}</a></div>`}
    </article>
    <article class="qs-opt${s.localModels ? " on" : ""}">
      <div class="qs-opt-head"><span class="qs-opt-icon">${icon("cpu")}</span><b>Local models (Ollama)</b>${chip(ollama.m, ollama.t)}</div>
      <p>Free and private: the model runs on your own graphics card. Weaker at long trips than Claude; a good GPU (12 GB+) helps.</p>
      <div class="qs-acts">${ollama.btn}</div>
    </article>
    <article class="qs-opt wide${anyKey(s) ? " on" : ""}">
      <div class="qs-opt-head"><span class="qs-opt-icon">${icon("key")}</span><b>An API key</b>${chip(anyKey(s) ? "ok" : "off", anyKey(s) ? "Set" : "None yet")}</div>
      <p>Pay per use with Anthropic, OpenAI or OpenRouter (a long trip with research on a top model costs a euro or two). Keys stay on this computer.</p>
      <div id="qsKeys" class="qs-keys"></div>
    </article>
  </div>`;
  return section(1, "A model to plan with", "The planner needs at least one. You can switch between them any time in the Model menu.",
    canPlan(s) ? `<span class="qs-badge ok">${icon("check")} Ready</span>` : `<span class="qs-badge need">Needed</span>`, body);
}

function researchSection(s: Setup) {
  const seg = (v: Setup["search"], label: string) => `<button type="button" class="seg${s.search === v ? " on" : ""}" data-search="${v}">${label}</button>`;
  const detail = s.search === "brave" ? `<div class="qs-brave qs-keys kf-svc">${serviceKeyField("brave", serviceKeys.brave, true)}</div>`
    : s.search === "searxng" ? (s.searxngUrl && s.searxngUrl !== SEARXNG_LOCAL
      ? `<p class="hint">${chip("ok", "Your own server")} Research goes to <code>${esc(s.searxngUrl)}</code>. To run one on this computer instead, change it in Settings → Planning.</p>`
      : `<div id="qsSearxng"></div>`)
    : `<p class="hint">Automatic uses Brave or SearXNG once one is set up; until then DuckDuckGo, which often stops with a bot check after a few searches. For local models that means thinner research.</p>
       <div class="qs-acts"><button type="button" class="btn solid" data-search="searxng">${icon("container")} Set up SearXNG (free, no account)</button><button type="button" class="btn" data-search="brave">${icon("key")} Use a Brave key</button></div>`;
  const badge = researchReady(s) ? `<span class="qs-badge ok">${icon("check")} Ready</span>`
    : s.localModels ? `<span class="qs-badge warn">Recommended</span>` : `<span class="qs-badge">Optional</span>`;
  return section(2, "Web research for local models", "Opening hours, prices and events from the web. Claude and API models search by themselves; local models search through the planner, so they need a search engine.",
    badge, `<div class="qs-research"><div class="qs-row"><b>Search engine</b><div class="segs">${seg("auto", "Automatic")}${seg("searxng", "SearXNG")}${seg("brave", "Brave")}</div></div>${detail}</div>`);
}

function extrasSection() {
  const row = (ico: Parameters<typeof icon>[0], title: string, text: string, tab: string, label: string) => `<div class="qs-link">
    <span class="qs-opt-icon">${icon(ico)}</span><div><b>${title}</b><p>${text}</p></div><button type="button" class="btn" data-settings="${tab}">${label}</button></div>`;
  return section(3, "Make it yours", "Optional, and all in Settings.", `<span class="qs-badge">Optional</span>`, `<div class="qs-links">
    <div class="qs-link qs-link-key"><span class="qs-opt-icon">${icon("images")}</span><div><b>Your photos on the map</b><p>With a free Google key, the photos of a Google Drive folder (shared as "Anyone with the link") show on the map at the spot each was taken. Settings → API keys says how to get one.</p>
      <div class="qs-keys kf-svc">${serviceKeyField("google", serviceKeys.google, true)}</div></div></div>
    <div class="qs-link qs-link-key"><span class="qs-opt-icon">${icon("pin")}</span><div><b>Faster place lookups</b><p>A free Geoapify key finds hundreds of saved places much faster (3,000 lookups a day).</p>
      <div class="qs-keys kf-svc">${serviceKeyField("geoapify", serviceKeys.geoapify, true)}</div></div></div>
    ${row("map", "Units and formats", "Kilometres or miles, 24 or 12-hour times, and what a new trip starts with.", "general", "General")}
    ${row("layers", "The map", "Local or English place names, Google, Apple or Bing Maps for links, transport lines for the Layers.", "map", "Map")}
    ${row("sliders", "How plans are made", "The plan's language, how much each stop says, how many real places and web lookups.", "planning", "Planning")}
    ${row("phone", "Your phone", "Use the planner on your phone over Wi-Fi, or anywhere with Tailscale.", "phone", "Phone")}
    ${row("refresh", "Updates", "The app looks for new versions by itself and updates in a click.", "updates", "Updates")}
  </div>`);
}

function firstTripSection() {
  const step = (n: number, ico: Parameters<typeof icon>[0], title: string, text: string, act: string, label: string) => `<li class="qs-trip-step" style="--i:${n}">
    <span class="qs-trip-num">${icon(ico)}</span><b>${title}</b><p>${text}</p><button type="button" class="link-btn" data-go="${act}">${label} →</button></li>`;
  return section(4, "Your first trip", "Four steps from an idea to a day-by-day plan.", "", `<ol class="qs-trip">
    ${step(0, "route", "Where to stay", "Add your stays with dates, or describe the trip and let Plan a route suggest them.", "route", "Plan a route")}
    ${step(1, "pin", "Places you like", "Import a Google Maps list or a CSV and star the must-sees.", "places", "Manage places")}
    ${step(2, "sparkles", "Generate", "Pick a model and generate: real places, real roads and opening hours are checked.", "generate", "To Planning")}
    ${step(3, "chat", "Fine-tune", "Ask the trip chat for changes (“make day 3 easier”), re-plan a day, export it for your phone.", "chat", "Open the chat")}
  </ol>`);
}

function render() {
  const body = $("#qsBody");
  if (error) { body.innerHTML = `${hero(null)}<p class="error-text">${icon("warn")} ${esc(error)}</p>`; return; }
  body.innerHTML = hero(setup) + (setup ? modelSection(setup) + researchSection(setup) + extrasSection() + firstTripSection() : "");
  if (!setup) return;
  if (!animated) { animated = true; body.classList.add("intro"); setTimeout(() => body.classList.remove("intro"), 2400); }
  const s = setup;
  renderKeyRows($("#qsKeys"), () => { refreshModels(); check(); }, s.keys);
  wireServiceKeys(body, (now) => { serviceKeys = now.serviceKeys || {}; check(); });
  body.querySelectorAll<HTMLButtonElement>("[data-settings]").forEach((b) => { b.onclick = () => toSettings(b.dataset.settings as Parameters<typeof openSettings>[0]); });
  body.querySelectorAll<HTMLButtonElement>("[data-search]").forEach((b) => { b.onclick = () => setSearch(b.dataset.search as Setup["search"]); });
  body.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => { b.onclick = () => go(b.dataset.go!); });
  const sx = document.querySelector<HTMLElement>("#qsSearxng");
  if (sx) mountSearxng(sx, { autoStart: true, compact: true, onChange: () => check() });
}

/** Research's search engine; picking SearXNG shows its steps (and starts it if it's set up). */
async function setSearch(search: Setup["search"]) {
  await api("/api/settings", { method: "POST", body: JSON.stringify({ tune: { search } }) });
  if (setup) { setup.search = search; render(); }
}

function toSettings(tab: Parameters<typeof openSettings>[0]) {
  // On top of the guide; when Settings closes, the guide checks again (something may have been installed).
  $<HTMLDialogElement>("#settingsDialog").addEventListener("close", () => { if (dialog().open) { check(); refreshModels(); } }, { once: true });
  openSettings(tab);
}

function go(what: string) {
  dialog().close();
  if (what === "route") $("#planRoute").click();
  else if (what === "places") $("#openPlaces").click();
  else if (what === "chat") { if (!$("#chatPanel").hidden) return; $("#chatBtn").click(); }
  else document.querySelector(".plan-card")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function check() {
  if (loading) return;
  loading = true; error = "";
  const btn = document.querySelector<HTMLButtonElement>("#qsRecheck");
  btn?.classList.add("spinning");
  try {
    const [now, settings] = await Promise.all([api<Setup>("/api/setup"), api<{ serviceKeys?: Record<ServiceKey, KeyStatus> }>("/api/settings").catch(() => null)]);
    setup = now; serviceKeys = settings?.serviceKeys || {};
  }
  catch (e) { error = `Couldn't check this computer: ${(e as Error).message}`; }
  loading = false; btn?.classList.remove("spinning");
  if (dialog().open) render();
}

export function openQuickstart() {
  const d = dialog();
  if (!d.open) { d.showModal(); animated = false; }
  render();
  check();
  // Seen: it doesn't open by itself again.
  api("/api/settings", { method: "POST", body: JSON.stringify({ quickstartSeen: true }) }).catch(() => {});
}

/** The first time the app starts (on this computer; not on a phone), the guide opens by itself. */
export async function maybeShowQuickstart() {
  const s = await api<{ quickstartSeen?: boolean }>("/api/settings").catch(() => null);
  if (s && !s.quickstartSeen) openQuickstart();
}

export function initQuickstart() {
  $("#quickstartBtn").onclick = openQuickstart;
  $("#qsRecheck").onclick = () => check();
  $("#qsDone").onclick = () => dialog().close();
  dialog().addEventListener("close", () => refreshModels());
}
