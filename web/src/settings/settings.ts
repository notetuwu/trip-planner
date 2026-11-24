// Settings, in tabs, with a search over all of them: General (how the app opens, theme, start-up and saving, units, what
// a new trip starts with, where the data is), Map (place names, the maps app, downloading transport lines), Planning
// (language, detail, how many real places and web lookups, fix rounds, the search engine), API keys (every key in one
// place: AI providers, Brave, Geoapify, Google), Local models (Ollama: status, the graphics card, models from ollama.com
// that fit it, a search of the library, installs with download progress, installed models, how they plan, the context
// size), Phone (the planner on the home network: start/stop, status, the link and its QR code), Updates and Credits.
import qrcode from "qrcode-generator";
import type { GpuInfo, KeyStatus } from "../../../shared/types";
import { $, $$, api, esc, toast } from "../core/dom";
import { ext, icon } from "../core/icons";
import { type AppPrefs, prefs, setPrefs } from "../core/prefs";
import { CURRENCIES } from "../core/format";
import { type Choice, choice, setTheme } from "../core/theme";
import { type UpdateInfo, install } from "../core/update";
import { switchWindowMode } from "../core/window-mode";
import { renderKeyRows } from "../generate/keys";
import { MODELS, suggestion } from "../generate/local-guide";
import { refreshModels } from "../generate/models";
import { mountSearxng } from "./searxng-panel";
import { creditsHtml } from "./credits";
import { keyFieldHtml, wireKeyFields } from "./key-field";
import { clearDownloaded, downloadText, onDownloadChange } from "../map/lines-download";
import { SEARXNG_LOCAL } from "./searxng-local";

interface Tune { language: string; detail: string; places: string; lookups: number; fixRounds: number; thinking: string; temperature: number; keepAlive: string; pages: string; search: string; localPlan: string }
export type ServiceKey = "brave" | "geoapify" | "google";
interface Settings { window: "app" | "browser"; numCtx: number; checkUpdates: boolean; serviceKeys?: Record<ServiceKey, KeyStatus>; braveKeySet: boolean; geoapifyKeySet: boolean; googleKeySet: boolean; searxngUrl: string; lan: boolean; packaged: boolean; appWindow: boolean; dataDir: string; version: string; tune: Tune; app?: AppPrefs }
interface Pull { name: string; status: string; total: number; completed: number; error?: string; done: boolean; started: number }
interface OllamaModel { name: string; size: number; params: string; quant: string; loaded: boolean }
interface OllamaInfo { installed: boolean; running: boolean; version: string; gpu: GpuInfo | null; models: OllamaModel[]; pulls: Pull[] }
interface OllamaInstall { phase: "idle" | "running" | "done" | "error"; log: string[]; error: string; started: number; command: string; canRun: boolean }
interface LanStatus { running: boolean; port: number; since: number; error: string; urls: string[]; awayUrls?: string[]; tailscale?: boolean; platform?: string }
interface LibModel { name: string; description: string; caps: string[]; sizes: string[]; downloads: number; context: string; updated: string; cloudOnly: boolean }
interface LibTag { name: string; sizeGb: number; context: string; inputs: string }
interface Rec { model: string; tag: string; sizeGb: number; context: string; caps: string[]; description: string; downloads: number }

interface UpdateState { info: (UpdateInfo & { checkedAt: number }) | null; error: string; waitUntil: number; auto: boolean; available: boolean }

type Tab = "general" | "map" | "planning" | "keys" | "models" | "phone" | "updates" | "credits";
const TABS: [Tab, Parameters<typeof icon>[0], string][] = [
  ["general", "settings", "General"], ["map", "map", "Map"], ["planning", "sliders", "Planning"], ["keys", "key", "API keys"],
  ["models", "cpu", "Local models"], ["phone", "phone", "Phone"], ["updates", "refresh", "Updates"], ["credits", "heart", "Credits"],
];
const tabName = (t: Tab) => TABS.find((x) => x[0] === t)![2];
let tab: Tab = "general", settings: Settings | null = null, ollama: OllamaInfo | null = null, lan: LanStatus | null = null;
/** The search box's text; while it has some, the page shows the settings that match instead of a tab. */
let find = "";
/** A key was added or removed while Settings was open: the Model menu lists the models again when it closes. */
let keysChanged = false, onKeysClosed: (() => void) | null = null;
let poll: number | undefined, loadError = "";
// The library: recommendations, the last search and its results, and the sizes of models opened in the results.
let recs: Rec[] | null = null, recsError = "", query = "", cap = "tools", results: LibModel[] | null = null, searching = false, searchError = "";
const tagsOf = new Map<string, LibTag[] | "loading" | "error">();
const opened = new Set<string>();
let allVariants = false;
let updates: UpdateState | null = null, checking = false;
let setup: OllamaInstall | null = null, setupPoll: number | undefined;

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes > 10 * 1024 ** 3 ? 0 : 1)} GB`;
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
const dialog = () => $<HTMLDialogElement>("#settingsDialog");

/** Opens Settings at a tab; onKeyChange runs when it closes, if an AI key was added or removed meanwhile. */
export async function openSettings(which: Tab = tab, onKeyChange?: () => void) {
  tab = which; find = "";
  keysChanged = false; onKeysClosed = onKeyChange || null;
  if (!dialog().open) dialog().showModal();
  render();
  await load();
}

async function load() {
  loadError = "";
  try {
    [settings, lan] = await Promise.all([api<Settings>("/api/settings"), api<LanStatus>("/api/lan")]);
  } catch (e) {
    // A phone on the home network can't change the computer's settings (the theme is its own, though).
    loadError = (e as Error).message;
  }
  render();
  if (tab === "models") loadModelsTab();
  if (tab === "updates") loadUpdates();
}

async function loadUpdates() {
  updates = await api<UpdateState>("/api/update/state").catch(() => updates);
  if (tab === "updates" && !find) renderUpdates();
}

function loadModelsTab() {
  loadOllama();
  if (!recs && !recsError) loadRecs();
  if (!results && !searching) search();
}

async function loadOllama() {
  try { ollama = await api<OllamaInfo>("/api/ollama"); } catch { ollama = null; }
  if (ollama && !ollama.installed && !setup) setup = await api<OllamaInstall>("/api/ollama/install").catch(() => null);
  renderModels();
  watchPulls();
}

async function loadRecs() {
  try {
    const r = await api<{ gpu: GpuInfo | null; models: Rec[] }>("/api/ollama/recommend");
    recs = r.models; recsError = "";
  } catch (e) { recs = null; recsError = (e as Error).message; }
  renderModels();
}

async function search() {
  searching = true; searchError = ""; renderModels();
  try { results = await api<LibModel[]>(`/api/ollama/library?q=${encodeURIComponent(query)}&cap=${cap}`); }
  catch (e) { results = null; searchError = (e as Error).message; }
  searching = false;
  renderModels();
}

async function loadTags(model: string) {
  tagsOf.set(model, "loading"); renderModels();
  try { tagsOf.set(model, await api<LibTag[]>(`/api/ollama/tags?model=${encodeURIComponent(model)}`)); } catch { tagsOf.set(model, "error"); }
  renderModels();
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

async function saveTune(part: Partial<Tune>) {
  settings = await api<Settings>("/api/settings", { method: "POST", body: JSON.stringify({ tune: part }) });
  prefs.fixRounds = settings.tune.fixRounds;
  toast("Saved: used for the next plan");
}

// ---- Rendering ----

function render() {
  const nav = ([t, ico, label]: (typeof TABS)[number]) =>
    `<button type="button" class="set-tab${tab === t && !find ? " on" : ""}" data-tab="${t}">${icon(ico)}<span>${label}</span></button>`;
  // The search box stays put (and keeps its focus) while the rest redraws.
  if (!document.querySelector("#setFind")) {
    $("#settingsBody").innerHTML = `
      <div class="set-side">
        <label class="set-find"><span class="set-find-icon">${icon("search")}</span><input id="setFind" type="search" placeholder="Search settings" autocomplete="off" spellcheck="false"></label>
        <nav class="set-nav" id="setNav"></nav>
      </div>
      <div class="set-main" id="setMain"></div>`;
    const input = $<HTMLInputElement>("#setFind");
    input.oninput = () => { find = input.value.trim(); render(); };
    input.onkeydown = (e) => {
      // Escape empties the search first (and only closes Settings when it's empty); Enter opens the first match.
      if (e.key === "Escape" && input.value) { e.preventDefault(); input.value = ""; find = ""; render(); }
      if (e.key === "Enter") document.querySelector<HTMLButtonElement>("#setMain [data-hit]")?.click();
    };
  }
  const input = $<HTMLInputElement>("#setFind");
  if (input.value.trim() !== find) input.value = find;
  $("#setNav").innerHTML = TABS.map(nav).join("");
  $$<HTMLButtonElement>("#setNav [data-tab]").forEach((b) => { b.onclick = () => showTab(b.dataset.tab as Tab); });
  if (find) renderFind();
  else if (tab === "general") renderGeneral();
  else if (tab === "credits") $("#setMain").innerHTML = creditsHtml();
  else if (loadError) $("#setMain").innerHTML = `<p class="hint">${esc(loadError)}</p>`;
  else if (tab === "map") renderMap();
  else if (tab === "planning") renderPlanning();
  else if (tab === "keys") renderKeys();
  else if (tab === "models") renderModels();
  else if (tab === "updates") renderUpdates();
  else renderPhone();
}

function showTab(t: Tab) {
  tab = t; find = "";
  render();
  $("#setMain").scrollTop = 0;
  if (tab === "models") loadModelsTab();
  if (tab === "updates") loadUpdates();
}

// ---- Search ----

/** more: the rest of the row's words (its choices, "Miles, °F"), searched but not shown. */
interface Hit { tab: Tab; title: string; hint: string; more?: string }

/** Settings on the tabs that are drawn from live state (models, phone, updates), so the search finds them too. */
const LIVE_HITS: Hit[] = [
  { tab: "models", title: "Ollama", hint: "Install or start Ollama, which runs AI models on your own computer." },
  { tab: "models", title: "Graphics card", hint: "The GPU the models run on, and how much memory it has." },
  { tab: "models", title: "Installed", hint: "The models on this computer; delete one to free space." },
  { tab: "models", title: "Recommended", hint: "Models from ollama.com that fit your graphics card." },
  { tab: "models", title: "Find models", hint: "Search the ollama.com library, or install a model by its exact name." },
  { tab: "models", title: "Context size", hint: "How much a local model can read and write at once." },
  { tab: "phone", title: "Phone access", hint: "Use the planner on your phone over Wi-Fi: a link and a QR code." },
  { tab: "phone", title: "Away from home", hint: "Use the planner anywhere with Tailscale, a free private network." },
  { tab: "updates", title: "Version", hint: "Which version you have, and what's new." },
  { tab: "updates", title: "Check now", hint: "Look for a new version of Trip Planner." },
  { tab: "updates", title: "Check automatically", hint: "Look for updates every hour while the app runs." },
  { tab: "credits", title: "Credits", hint: "The maps, data and open-source software the planner uses." },
];

/** Every setting's title and description, read from the tabs' own markup (so the search can't drift from them). */
function hits(): Hit[] {
  if (!settings) return LIVE_HITS;
  const out: Hit[] = [];
  const read = (t: Tab, html: string) => {
    const box = document.createElement("div");
    box.innerHTML = html;
    // Not the short notes that point to a key on another tab (the key itself is found under API keys).
    for (const row of $$<HTMLElement>(".set-row:not(.key-note), .kf", box)) {
      const title = row.querySelector("b")?.textContent?.trim();
      const hint = row.querySelector(".hint")?.textContent?.trim() || "";
      const more = [...row.querySelectorAll("button, option, label")].map((e) => e.textContent?.trim()).join(" ");
      if (title && !out.some((h) => h.tab === t && h.title === title)) out.push({ tab: t, title, hint, more });
    }
  };
  read("general", generalHtml()); read("map", mapHtml()); read("planning", planningHtml(true)); read("keys", keysHtml(true)); read("models", localPlanHtml());
  return [...out, ...LIVE_HITS];
}

function renderFind() {
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const head = (h: Hit) => `${h.title} ${tabName(h.tab)}${h.tab === "keys" ? " api key token" : ""}`.toLowerCase();
  const text = (h: Hit) => `${head(h)} ${h.hint} ${h.more || ""}`.toLowerCase();
  // Matches in the title (or the tab's name: every key for "key") first, then the ones only in the description.
  const top = (h: Hit) => Number(words.every((w) => head(h).includes(w)));
  const found = hits().filter((h) => words.every((w) => text(h).includes(w))).sort((a, b) => top(b) - top(a));
  const mark = (s: string) => {
    let out = esc(s);
    for (const w of words) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "&amp;")})`, "gi"), "<mark>$1</mark>");
    return out;
  };
  const snip = (s: string) => {
    const at = Math.max(0, ...words.map((w) => s.toLowerCase().indexOf(w)));
    return s.length <= 160 ? s : `${at > 80 ? "…" : ""}${s.slice(Math.max(0, at - 60), Math.max(0, at - 60) + 160)}…`;
  };
  $("#setMain").innerHTML = `
    <h3>${found.length ? `${found.length} setting${found.length > 1 ? "s" : ""} match “${esc(find)}”` : `Nothing matches “${esc(find)}”`}</h3>
    ${found.length ? `<div class="set-hits">${found.map((h, i) => `<button type="button" class="set-hit" data-hit="${i}">
        <span class="set-hit-tab">${icon(TABS.find((t) => t[0] === h.tab)![1])} ${esc(tabName(h.tab))}</span>
        <b>${mark(h.title)}</b>${h.hint ? `<span class="hint">${mark(snip(h.hint))}</span>` : ""}</button>`).join("")}</div>`
      : `<p class="hint">Try another word: “key”, “miles”, “language”, “photos”, “phone”…</p>`}`;
  $$<HTMLButtonElement>("#setMain [data-hit]").forEach((b) => { b.onclick = () => jumpTo(found[+b.dataset.hit!]); });
  $("#setMain").scrollTop = 0;
}

/** Opens the setting's tab and shows it, lit up for a moment. */
function jumpTo(h: Hit) {
  showTab(h.tab);
  // Some tabs draw after loading: look for the row a few times.
  let tries = 0;
  const look = () => {
    const row = $$<HTMLElement>("#setMain .set-row, #setMain .kf, #setMain .set-card").find((r) => r.querySelector("b")?.textContent?.trim() === h.title);
    if (!row) { if (++tries < 20) setTimeout(look, 150); return; }
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("set-flash"); void row.offsetWidth; row.classList.add("set-flash");
  };
  look();
}

/** Saves part of Settings → General; the page redraws in the new units and formats (see prefs.ts). */
async function saveApp(part: Partial<AppPrefs>) {
  settings = await api<Settings>("/api/settings", { method: "POST", body: JSON.stringify({ app: part }) });
  setPrefs(settings);
  toast("Saved");
}

const appSeg = (a: AppPrefs) => (k: keyof AppPrefs, v: string | boolean, label: string) => `<button type="button" class="seg${String(a[k]) === String(v) ? " on" : ""}" data-app="${k}" data-v="${v}">${label}</button>`;

/** General: how it opens and looks, start-up and saving, units and formats, what a new trip starts with, the data. */
function generalHtml() {
  const s = settings, th = choice(), a = settings?.app || prefs.app, seg = appSeg(a);
  const themeSeg = (c: Choice, label: string) => `<button type="button" class="seg${th === c ? " on" : ""}" data-theme-choice="${c}">${label}</button>`;
  const opt = (v: string | number, label: string, now: string | number) => `<option value="${v}"${String(v) === String(now) ? " selected" : ""}>${label}</option>`;
  const t = a.newTrip;
  return `
    <h3>General</h3>
    <div class="set-card">
      <b class="card-title">Look &amp; feel</b>
      ${s?.packaged && s.appWindow ? `<div class="set-row"><div><b>Opens in</b><div class="hint">How the planner opens when you start it.</div></div>
        <select id="setWindow"><option value="app">Its own window</option><option value="browser">A browser tab</option></select></div>` : ""}
      <div class="set-row"><div><b>Theme</b><div class="hint">Light, dark, or following your system${loadError ? " (on this device)" : ""}.</div></div>
        <div class="segs">${themeSeg("system", "System")}${themeSeg("light", "Light")}${themeSeg("dark", "Dark")}</div></div>
    </div>
    ${loadError ? `<p class="hint">The other settings are on the computer the planner runs on.</p>` : `
    <div class="set-card">
      <b class="card-title">Start-up &amp; saving</b>
      <div class="set-row"><div><b>On start</b><div class="hint">Open the trip you had open, or start a new one. With a new one, the trip that was open is kept in Saved trips first.</div></div>
        <div class="segs">${seg("startWith", "last", "Last trip")}${seg("startWith", "new", "New trip")}</div></div>
      <div class="set-row"><div><b>Save new plans by themselves</b><div class="hint">After each generated plan, the trip is saved to Saved trips (into its own save if it has one, otherwise under its cities' names).</div></div>
        <div class="segs">${seg("autoSave", true, "On")}${seg("autoSave", false, "Off")}</div></div>
      <div class="set-row"><div><b>Keep saved trips up to date by themselves</b><div class="hint">A trip that has a save is written back to it a few seconds after each change, so Save isn't needed and opening another trip can't lose work. The last 40 versions of each save are kept (Your trips → Recover), and a copy of the open trip is kept whenever it's replaced.</div></div>
        <div class="segs">${seg("liveSave", true, "On")}${seg("liveSave", false, "Off")}</div></div>
    </div>
    <div class="set-card">
      <b class="card-title">Pictures</b>
      <div class="set-row"><div><b>Pictures of places from Wikimedia</b><div class="hint">For the trip preview: each stop is looked up on Wikipedia (its name and town are sent) and shown with a freely licensed picture where one is found. Your own photos always come first.</div></div>
        <div class="segs">${seg("placePictures", true, "On")}${seg("placePictures", false, "Off")}</div></div>
    </div>
    <div class="set-card">
      <b class="card-title">Units &amp; formats</b>
      <div class="set-row"><div><b>Units</b><div class="hint">Distances on the map and in the plan, and temperatures in the forecast.</div></div>
        <div class="segs">${seg("units", "km", "Kilometres, °C")}${seg("units", "mi", "Miles, °F")}</div></div>
      <div class="set-row"><div><b>Times</b><div class="hint">How the plan's times are shown (14:30 or 2:30 pm). Calendar files always use your calendar's own setting.</div></div>
        <div class="segs">${seg("clock", "24", "24-hour")}${seg("clock", "12", "12-hour")}</div></div>
      <div class="set-row"><div><b>Dates</b><div class="hint">As your system writes them, day first (Mon, 2 Nov) or month first (Mon, Nov 2).</div></div>
        <div class="segs">${seg("dates", "auto", "System")}${seg("dates", "dmy", "2 Nov")}${seg("dates", "mdy", "Nov 2")}</div></div>
    </div>
    <div class="set-card">
      <b class="card-title">New trips start with</b>
      <div class="set-grid">
        <label>Travelers<input type="number" min="1" max="30" id="ntTravelers" value="${t.travelers}"></label>
        <label>Budget per person / day<input type="number" min="0" id="ntBudget" value="${t.dailyBudget}"></label>
        <label>Currency<select id="ntCurrency">${CURRENCIES.map((c) => opt(c, c, t.currency)).join("")}</select></label>
        <label>Pace<select id="ntPace">${opt("relaxed (2-3 main stops per day, late starts)", "Relaxed", t.pace)}${opt("balanced (3-5 stops per day)", "Balanced", t.pace)}${opt("packed (as much as possible, early starts)", "Packed", t.pace)}</select></label>
      </div>
      <p class="hint">New trips keep the model you plan with.</p>
    </div>
    <div class="set-card">
      <div class="set-row"><div><b>Your data</b><div class="hint">Saved trips, place lists, caches and settings live in this folder on your computer.</div>
        <code class="set-path">${esc(s?.dataDir || "")}</code></div>
        <button type="button" class="btn" id="setCopyPath">${icon("copy")} Copy</button></div>
    </div>`}`;
}

/** Map: what it starts with, where links open, and the transport lines downloaded for the Layers. */
function mapHtml() {
  const a = settings?.app || prefs.app, seg = appSeg(a);
  return `
    <h3>Map</h3>
    <div class="set-card">
      <b class="card-title">The map</b>
      <div class="set-row"><div><b>Place names</b><div class="hint">What the map starts with: names in the local language and script, or in English. The Layers button on the map changes it until the next start.</div></div>
        <div class="segs">${seg("mapNames", "local", "Local")}${seg("mapNames", "english", "English")}</div></div>
      <div class="set-row"><div><b>Show at start</b><div class="hint">Your saved places and the routes between stops; the boxes on the map turn them on and off for now.</div></div>
        <div class="set-checks"><label class="inline-check"><input type="checkbox" data-app-check="showPlaces"${a.showPlaces ? " checked" : ""}> Places</label><label class="inline-check"><input type="checkbox" data-app-check="showRoutes"${a.showRoutes ? " checked" : ""}> Routes</label></div></div>
      <div class="set-row"><div><b>Maps app</b><div class="hint">Where the links to places and directions open (also in the phone file and the calendar).</div></div>
        <div class="segs">${seg("mapsApp", "google", "Google")}${seg("mapsApp", "apple", "Apple")}${seg("mapsApp", "bing", "Bing")}</div></div>
    </div>
    <div class="set-card">
      <b class="card-title">Transport lines</b>
      <div class="set-row"><div><b>Download transport lines</b><div class="hint">Fetches the bus, tram, metro, train, boat and cable car lines for the map's Layers around your stays and each day's stops, in the background: slowly, one area at a time, and never while a plan is being made. Then they show straight away. Kept for 90 days.</div></div>
        <div class="segs">${seg("linesDownload", true, "On")}${seg("linesDownload", false, "Off")}</div></div>
      <div class="set-row"><div><b>Around each stay</b><div class="hint">How far around where you sleep. Further takes longer and more space (a city's area is up to about half a megabyte).</div></div>
        <div class="segs">${seg("linesRadius", "5", "5 km")}${seg("linesRadius", "10", "10 km")}${seg("linesRadius", "20", "20 km")}</div></div>
      <div class="set-row"><div><b>Downloaded lines</b><div class="hint" id="linesStatus">${esc(downloadText() || "Checking…")}</div></div>
        <button type="button" class="btn" id="linesClear" title="Delete every downloaded area (the trip's areas download again if it's on)">Clear</button></div>
      <div class="set-row set-row-wide"><div><b>Kept in</b><div class="hint">The folder the downloaded lines are kept in, on the computer the planner runs on. Changing it moves what's there now.</div></div>
        <div class="lines-dir">
          <input type="text" id="linesDir" spellcheck="false" autocomplete="off" placeholder="Loading…">
          <div class="lines-dir-btns"><button type="button" class="btn" id="linesDirSet">Move here</button><button type="button" class="link-btn" id="linesDirDefault" hidden>Back to default</button></div>
          <span class="hint" id="linesDirNote"></span>
        </div></div>
    </div>`;
}

/** "Kept in": the downloads' folder, which can be typed in (what's there is moved across) or set back to the default. */
function wireLinesDir() {
  const input = document.querySelector<HTMLInputElement>("#linesDir");
  if (!input) return;
  const set = $<HTMLButtonElement>("#linesDirSet"), back = $<HTMLButtonElement>("#linesDirDefault"), note = $("#linesDirNote");
  type Loc = { dir: string; default: string; custom: boolean };
  const show = (loc: Loc) => {
    input.value = loc.dir; input.placeholder = loc.default; input.dataset.now = loc.dir;
    back.hidden = !loc.custom;
    note.textContent = loc.custom ? `Default: ${loc.default}` : "The app's own cache folder.";
  };
  api<{ location: Loc }>("/api/lines/disk").then((d) => show(d.location)).catch(() => { input.placeholder = "The planner isn't answering"; });
  const move = async (dir: string) => {
    set.disabled = true; back.disabled = true;
    note.textContent = "Moving the downloads…";
    try {
      const r = await api<{ location: Loc }>("/api/lines/location", { method: "POST", body: JSON.stringify({ dir }) });
      show(r.location);
      toast(r.location.custom ? "Downloads are kept in the new folder" : "Downloads are back in the app's folder");
      const el = document.getElementById("linesStatus");
      if (el) el.textContent = downloadText() || el.textContent;
    } catch (e) { note.textContent = (e as Error).message; }
    finally { set.disabled = false; back.disabled = false; }
  };
  set.onclick = () => { const v = input.value.trim(); if (v && v !== input.dataset.now) move(v); };
  input.onkeydown = (e) => { if (e.key === "Enter") set.click(); };
  back.onclick = () => move("");
}

/** The download's progress line is followed once (the section is redrawn often; the line is looked up each time). */
let linesHooked = false;
/** The on/off and choice buttons of General and Map: saved at once, then the tab is drawn again. */
function wireAppChoices(redraw: () => void) {
  $$<HTMLButtonElement>("#setMain [data-app]").forEach((b) => {
    b.onclick = async () => { const raw = b.dataset.v!; await saveApp({ [b.dataset.app!]: raw === "true" ? true : raw === "false" ? false : raw } as Partial<AppPrefs>); redraw(); };
  });
  $$<HTMLInputElement>("#setMain [data-app-check]").forEach((c) => { c.onchange = () => saveApp({ [c.dataset.appCheck!]: c.checked } as Partial<AppPrefs>); });
}

function wireGeneral() {
  wireAppChoices(renderGeneral);
  const trip = () => ({ newTrip: {
    travelers: Number($<HTMLInputElement>("#ntTravelers").value) || 1, dailyBudget: Number($<HTMLInputElement>("#ntBudget").value) || 0,
    currency: $<HTMLSelectElement>("#ntCurrency").value, pace: $<HTMLSelectElement>("#ntPace").value,
  } });
  for (const id of ["#ntTravelers", "#ntBudget", "#ntCurrency", "#ntPace"]) document.querySelector<HTMLElement>(id)?.addEventListener("change", () => saveApp(trip()));
}

function renderMap() {
  $("#setMain").innerHTML = mapHtml();
  wireAppChoices(renderMap);
  // The download's progress, as it goes; with nothing asked yet, just what's on disk.
  const status = () => { const el = document.getElementById("linesStatus"); if (el) el.textContent = downloadText() || el.textContent; };
  if (!linesHooked) { linesHooked = true; onDownloadChange(status); }
  if (!downloadText()) api<{ areas: number; bytes: number }>("/api/lines/disk").then((disk) => {
    const el = document.getElementById("linesStatus");
    if (el && !downloadText()) el.textContent = downloadText({ total: 0, ready: 0, left: 0, failed: 0, disk });
  }).catch(() => {});
  wireLinesDir();
  const clear = document.querySelector<HTMLButtonElement>("#linesClear");
  if (clear) clear.onclick = async () => {
    if (!confirm("Delete all downloaded transport lines?")) return;
    clear.disabled = true;
    try { await clearDownloaded(); toast("Downloaded lines deleted"); } finally { clear.disabled = false; status(); }
  };
}

function renderGeneral() {
  const s = settings;
  $("#setMain").innerHTML = generalHtml();
  const win = document.querySelector<HTMLSelectElement>("#setWindow");
  if (win && s) {
    win.value = s.window;
    win.onchange = async () => { if (!(await switchWindowMode(win.value as "app" | "browser"))) { s.window = win.value as "app" | "browser"; toast("Saved: it opens that way from the next start"); } };
  }
  $$<HTMLButtonElement>("[data-theme-choice]").forEach((b) => { b.onclick = () => { setTheme(b.dataset.themeChoice as Choice); renderGeneral(); }; });
  if (!loadError) wireGeneral();
  document.querySelector<HTMLButtonElement>("#setCopyPath")?.addEventListener("click", () => navigator.clipboard.writeText(s?.dataDir || "").then(() => toast("Copied the folder path")));
}

const LANGUAGES = ["", "Deutsch", "Français", "Español", "Italiano", "Português", "Nederlands", "Polski", "Čeština", "Svenska", "Dansk", "Norsk", "Suomi", "Türkçe", "日本語", "한국어", "中文"];

const tuneOpt = (v: string | number, label: string, now: string | number) => `<option value="${v}"${String(v) === String(now) ? " selected" : ""}>${label}</option>`;
const tuneSeg = (t: Tune) => (k: keyof Tune, v: string, label: string) => `<button type="button" class="seg${String(t[k]) === v ? " on" : ""}" data-tune="${k}" data-v="${v}">${label}</button>`;
/** A saved key, briefly, where a setting depends on it (the full field is under API keys). */
const keyNote = (k: ServiceKey, name: string) => {
  const s = settings?.serviceKeys?.[k];
  return `<div class="set-row key-note"><div><b>${icon("key")} ${name}</b><div class="hint">${s?.set ? `Saved, ending in <code>${esc(s.hint.replace("…", ""))}</code>.` : "Not set yet: until it is, research uses the automatic choice."}</div></div>
    <button type="button" class="btn${s?.set ? "" : " solid"}" data-to-keys="${k}">${s?.set ? "Change in API keys" : `${icon("key")} Add the key`}</button></div>`;
};

/** Planning: the plan, and researching online. `all`: every row, whatever is chosen (for the search). */
function planningHtml(all = false) {
  const t = settings!.tune, seg = tuneSeg(t), opt = tuneOpt;
  return `
    <h3>Planning</h3>
    <div class="set-card">
      <b class="card-title">The plan</b>
      <div class="set-row"><div><b>Language</b><div class="hint">What the plan is written in. Place names stay as they're known locally.</div></div>
        <select id="tuneLang">${LANGUAGES.map((l) => opt(l, l || "English", t.language)).join("")}${t.language && !LANGUAGES.includes(t.language) ? opt(t.language, t.language, t.language) : ""}</select></div>
      <div class="set-row"><div><b>Descriptions</b><div class="hint">How much each stop's description says. Brief is quicker to read and to write (faster with local models).</div></div>
        <div class="segs">${seg("detail", "brief", "Brief")}${seg("detail", "normal", "Normal")}${seg("detail", "detailed", "Detailed")}</div></div>
      <div class="set-row"><div><b>Real places per stay</b><div class="hint">How many sights and restaurants from OpenStreetMap the model gets for each stay. Fewer makes a shorter prompt (faster, fits small models); more gives more choice.</div></div>
        <div class="segs">${seg("places", "fewer", "Fewer")}${seg("places", "normal", "Normal")}${seg("places", "more", "More")}</div></div>
      <div class="set-row"><div><b>Fix rounds</b><div class="hint">With "Fix what the checks find" on: how many times stops in the wrong town or closed at the planned time go back to the model before you see the plan. Each round checks again.</div></div>
        <div class="segs">${seg("fixRounds", "0", "None")}${seg("fixRounds", "1", "1")}${seg("fixRounds", "2", "2")}</div></div>
    </div>
    <div class="set-card">
      <b class="card-title">Researching online</b>
      <p class="hint set-note">For local models: the planner searches and reads pages for them. Claude and API models use their provider's own web search.</p>
      <div class="set-row"><div><b>Search engine</b><div class="hint">Automatic uses Brave or SearXNG when set up, otherwise DuckDuckGo (which often shows a bot check after a few searches), then Wikipedia and Wikivoyage.</div></div>
        <div class="segs">${seg("search", "auto", "Automatic")}${seg("search", "brave", "Brave")}${seg("search", "searxng", "SearXNG")}</div></div>
      ${t.search === "brave" || all ? keyNote("brave", "Brave Search API key") : ""}
      ${t.search === "searxng" || all ? `<div class="set-row sx-row"><div><b>${icon("container")} SearXNG on this computer</b><div class="hint">A free search engine that asks Google, Bing, DuckDuckGo and others at once and combines their results, with no account or key. It runs in Docker, only reachable from this computer; with SearXNG chosen here, the planner starts Docker and it whenever they're needed.</div>
          <div id="sxPanel"></div>
          <details class="sx-own"${settings?.searxngUrl && settings.searxngUrl !== SEARXNG_LOCAL ? " open" : ""}><summary>Use your own SearXNG server instead</summary>
            <div class="hint">On a home server, say: turn on its JSON format, then enter its address, e.g. http://192.168.1.20:8080.</div>
            <div class="set-inline"><input id="searxngUrl" type="url" autocomplete="off" placeholder="http://…" value="${esc(settings?.searxngUrl && settings.searxngUrl !== SEARXNG_LOCAL ? settings.searxngUrl : "")}"><button type="button" class="btn" id="searxngSave">Save</button></div></details></div></div>` : ""}
      <div class="set-row"><div><b>Web lookups</b><div class="hint">With "Research online" on: the most searches and page reads per plan. More finds more (opening hours, prices, events) but takes longer.</div></div>
        <select id="tuneLookups">${[5, 10, 20, 30, 45].map((n) => opt(n, `Up to ${n}`, t.lookups)).join("")}</select></div>
      <div class="set-row"><div><b>Opening web pages</b><div class="hint">Which pages the model may read. "Found" ones came up in a search or are linked from a page it read; letting it open pages it knows (an official site it remembers) helps when searches come back thin. Pages on this computer or your home network are never opened.</div></div>
        <select id="tunePages">${opt("found", "Only pages it found", t.pages)}${opt("known", "Found, plus up to 6 it knows", t.pages)}${opt("any", "Any public page", t.pages)}</select></div>
    </div>
    <p class="hint">How local models think, and their context size, are under <button type="button" class="link-btn" data-to-tab="models">Local models</button>. Keys are under <button type="button" class="link-btn" data-to-tab="keys">API keys</button>.</p>`;
}

/** How local models plan: in one go or step by step, thinking, creativity, how long they stay loaded. */
function localPlanHtml() {
  const t = settings?.tune;
  if (!t) return "";
  const seg = tuneSeg(t), opt = tuneOpt;
  return `<div class="set-card">
      <b class="card-title">How local models plan</b>
      <div class="set-row"><div><b>How they plan</b><div class="hint">In one go: the whole trip in one big request. Step by step: first an outline (which day goes where, with which of your places), then research for exactly those days, then each day on its own with only its places. Experimental: in tests with a 27B model, planning in one go gave better plans; try step by step if one go gets cut off or a smaller model can't manage the whole trip. Re-planning a day and fixes are always one request.</div></div>
        <div class="segs">${seg("localPlan", "whole", "In one go")}${seg("localPlan", "steps", "Step by step (experimental)")}</div></div>
      <div class="set-row"><div><b>Thinking</b><div class="hint">Models that can think first plan more carefully; off answers straight away (much faster, sometimes sloppier).</div></div>
        <div class="segs">${seg("thinking", "on", "On")}${seg("thinking", "off", "Off")}</div></div>
      <div class="set-row"><div><b>Creativity</b> <span class="hint" id="tuneTempVal">${t.temperature.toFixed(1)}</span><div class="hint">Low sticks to the obvious choices and the format; high varies more (and slips more often). 0.4 suits most models.</div></div>
        <input type="range" id="tuneTemp" min="0" max="1" step="0.1" value="${t.temperature}" class="set-range"></div>
      <div class="set-row"><div><b>Keep the model loaded</b><div class="hint">After a plan, how long Ollama keeps the model in graphics memory, so the next plan or fix starts at once. Longer keeps the memory busy.</div></div>
        <select id="tuneKeep">${opt("5m", "5 minutes", t.keepAlive)}${opt("30m", "30 minutes", t.keepAlive)}${opt("2h", "2 hours", t.keepAlive)}${opt("-1", "Until Ollama stops", t.keepAlive)}</select></div>
    </div>`;
}

/** The tune buttons and lists on the tab that's open (Planning or Local models), saved at once. */
function wireTune(redraw: () => void) {
  $$<HTMLButtonElement>("#setMain [data-tune]").forEach((b) => {
    b.onclick = async () => { const k = b.dataset.tune as keyof Tune, raw = b.dataset.v!; await saveTune({ [k]: k === "fixRounds" ? Number(raw) : raw }); redraw(); };
  });
  const on = (id: string, f: (v: string) => Partial<Tune>) => { const el = document.querySelector<HTMLSelectElement>(id); if (el) el.onchange = () => saveTune(f(el.value)); };
  on("#tuneLang", (v) => ({ language: v }));
  on("#tuneLookups", (v) => ({ lookups: Number(v) }));
  on("#tunePages", (v) => ({ pages: v }));
  on("#tuneKeep", (v) => ({ keepAlive: v }));
  const temp = document.querySelector<HTMLInputElement>("#tuneTemp");
  if (temp) {
    temp.oninput = () => { $("#tuneTempVal").textContent = Number(temp.value).toFixed(1); };
    temp.onchange = () => saveTune({ temperature: Number(temp.value) });
  }
  // Links to other tabs ("Add the key" goes to API keys and lights the key up).
  $$<HTMLButtonElement>("#setMain [data-to-tab]").forEach((b) => { b.onclick = () => showTab(b.dataset.toTab as Tab); });
  $$<HTMLButtonElement>("#setMain [data-to-keys]").forEach((b) => {
    b.onclick = () => jumpTo({ tab: "keys", title: SERVICE_KEYS.find((k) => k.id === b.dataset.toKeys)!.name, hint: "" });
  });
}

function renderPlanning() {
  if (!settings?.tune) { $("#setMain").innerHTML = `<p class="hint">Loading…</p>`; return; }
  $("#setMain").innerHTML = planningHtml();
  wireTune(renderPlanning);
  document.querySelector<HTMLButtonElement>("#searxngSave")?.addEventListener("click", async () => {
    settings = await api<Settings>("/api/settings", { method: "POST", body: JSON.stringify({ searxngUrl: $<HTMLInputElement>("#searxngUrl").value.trim() }) });
    toast("Saved the SearXNG address"); renderPlanning();
  });
  // SearXNG chosen: its steps, and Docker and it started if they're set up but stopped (unless research goes to
  // another SearXNG server).
  const sx = document.querySelector<HTMLElement>("#sxPanel");
  if (sx) mountSearxng(sx, {
    autoStart: !settings?.searxngUrl || settings.searxngUrl === SEARXNG_LOCAL,
    onChange: async () => { settings = await api<Settings>("/api/settings"); if (tab === "planning" && !find) renderPlanning(); },
  });
}

// ---- API keys ----

const SERVICE_KEYS: { id: ServiceKey; field: "braveKey" | "geoapifyKey" | "googleKey"; name: string; env: string; url: string; note: string }[] = [
  { id: "brave", field: "braveKey", name: "Brave Search API key", env: "BRAVE_API_KEY", url: "https://brave.com/search/api/",
    note: "Reliable web search for local models' research; the free plan covers a good number of searches a month. Used when Planning → Search engine is Brave (or Automatic)." },
  { id: "geoapify", field: "geoapifyKey", name: "Geoapify key", env: "GEOAPIFY_API_KEY", url: "https://www.geoapify.com/",
    note: "Finding hundreds of saved places takes a while with the free public services (Nominatim and Photon). A free Geoapify key adds a third, faster one that works alongside them (3,000 lookups a day). Without it nothing changes." },
  { id: "google", field: "googleKey", name: "Google API key", env: "GOOGLE_API_KEY", url: "https://console.cloud.google.com/apis/credentials",
    note: `Shows the photos of a Google Drive folder on the map (Layers → Photos), at the spot each was taken; the folder has to be shared as "Anyone with the link". To get a free key: open the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Drive API page${ext()}</a>, choose or create a project and press <b>Enable</b>; then under <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials${ext()}</a> choose <b>Create credentials → API key</b>.` },
];
/** A Brave, Geoapify or Google key field; `brief`: without the long explanation (the quick-start guide has its own). */
export const serviceKeyField = (k: ServiceKey, status?: KeyStatus, brief = false) => {
  const f = SERVICE_KEYS.find((x) => x.id === k)!;
  return keyFieldHtml({ id: f.id, name: f.name, status, env: f.env, url: f.url, note: brief ? "" : f.note });
};
/** Saves (or with "" removes) a Brave, Geoapify or Google key; what's set now comes back. */
export async function saveServiceKey(k: ServiceKey, key: string) {
  const f = SERVICE_KEYS.find((x) => x.id === k)!;
  const s = await api<Settings>("/api/settings", { method: "POST", body: JSON.stringify({ [f.field]: key }) });
  toast(key ? `Saved the ${f.name}` : `Removed the ${f.name}`);
  return s;
}

/** API keys: the AI providers' (planning with a paid account), then web search, place lookups and photos. `all`: with
 *  the AI providers' rows written out (for the search; on the page they're filled in after loading). */
function keysHtml(all = false) {
  const k = settings?.serviceKeys;
  const ai = all ? `<div class="kf"><b>Anthropic</b><div class="hint">Claude models with Anthropic's web search.</div></div><div class="kf"><b>OpenAI</b><div class="hint">GPT models with OpenAI's web search.</div></div><div class="kf"><b>OpenRouter</b><div class="hint">One key for many labs' models.</div></div>` : "";
  return `
    <h3>API keys</h3>
    <p class="hint set-intro">Every key in one place. All are optional and stay on this computer: kept in the planner's folder, only ever sent to their own service, and never in saves or exports.</p>
    <div class="set-card kf-card">
      <b class="card-title">${icon("sparkles")} AI models</b>
      <p class="hint">Plan with cloud models that search the web themselves. You pay the provider per use (a long trip with research on a top model can cost a euro or two; smaller models much less; the cost is shown after each plan where known).</p>
      <div id="aiKeys" class="kf-list">${ai || `<p class="hint">Loading…</p>`}</div>
    </div>
    <div class="set-card kf-card">
      <b class="card-title">${icon("search")} Web search</b>
      <div class="kf-list kf-svc">${serviceKeyField("brave", k?.brave)}</div>
    </div>
    <div class="set-card kf-card">
      <b class="card-title">${icon("pin")} Finding places</b>
      <div class="kf-list kf-svc">${serviceKeyField("geoapify", k?.geoapify)}</div>
    </div>
    <div class="set-card kf-card">
      <b class="card-title">${icon("images")} Photos on the map</b>
      <div class="kf-list kf-svc">${serviceKeyField("google", k?.google)}</div>
    </div>`;
}

function renderKeys() {
  if (!settings) { $("#setMain").innerHTML = `<p class="hint">Loading…</p>`; return; }
  $("#setMain").innerHTML = keysHtml();
  renderKeyRows($("#aiKeys"), () => { keysChanged = true; refreshModels(); });
  wireServiceKeys($("#setMain"), (s) => { settings = s; if (tab === "keys" && !find) renderKeys(); });
}

/** Wires the Brave, Geoapify and Google key fields inside `root` (each in a .kf-svc box); after() gets the settings
 *  once one is saved or removed. */
export function wireServiceKeys(root: ParentNode, after: (s: Settings) => void) {
  const names = Object.fromEntries(SERVICE_KEYS.map((k) => [k.id, k.name.replace(/ (API )?key$/, "")]));
  for (const box of $$(".kf-svc", root)) wireKeyFields(box, async (id, key) => after(await saveServiceKey(id as ServiceKey, key)), names);
}

const time = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

function renderUpdates() {
  const main = document.querySelector<HTMLElement>("#setMain");
  if (!main || tab !== "updates" || find) return;
  const u = updates, info = u?.info, s = settings;
  const waiting = !!u && u.waitUntil > Date.now();
  const status = !u ? `<span class="dot"></span> Loading…`
    : !u.available ? `<span class="dot off"></span> Only the installed app looks for updates (this copy runs from the source).`
    : checking ? `<span class="dot"></span> Asking GitHub…`
    : u.error ? `<span class="dot warn"></span> Couldn't check: ${esc(u.error)}`
    : info?.newer ? `<span class="dot ok"></span> Trip Planner <b>${esc(info.latest)}</b> is available`
    : info ? `<span class="dot ok"></span> Up to date`
    : `<span class="dot"></span> Not checked yet`;
  const auto = info?.newer && (info.mode === "installer" || info.mode === "portable");
  main.innerHTML = `
    <h3>Updates</h3>
    <div class="set-card">
      <div class="set-row"><div><b>Version</b><div class="hint">You have Trip Planner ${esc(s?.version || info?.current || "")}.</div></div>
        <a class="btn" href="https://github.com/notetuwu/trip-planner/releases" target="_blank" rel="noopener">What's new${ext()}</a></div>
      <div class="set-row"><div><b class="status">${status}</b>
          <div class="hint">${info?.checkedAt ? `Last checked ${time(info.checkedAt)}.` : ""}${waiting ? ` The next check can be after ${time(u!.waitUntil)}.` : ""}</div></div>
        <div class="m-act">
          ${info?.newer ? `<button type="button" class="btn solid" id="updInstall">${icon("download")} ${auto ? "Update now" : "Download"}</button>` : ""}
          ${u?.available ? `<button type="button" class="btn" id="updCheck" ${checking || waiting ? "disabled" : ""}>${icon("refresh")} Check now</button>` : ""}
        </div></div>
      ${u?.available ? `<div class="set-row"><div><label class="inline-check"><input type="checkbox" id="updAuto" ${u.auto ? "checked" : ""}> <b>Check automatically</b></label>
        <div class="hint">Every hour while the app runs (and when it starts), a bar at the top offers a new version. It backs off when GitHub says to wait, so your home connection never gets blocked.</div></div></div>` : ""}
    </div>
    <p class="hint">On Windows, Update now downloads the new version (checked against GitHub's checksum), installs it and restarts; your data stays where it is. On macOS and Linux it opens the download page.</p>`;
  document.querySelector<HTMLButtonElement>("#updCheck")?.addEventListener("click", async () => {
    checking = true; renderUpdates();
    updates = await api<UpdateState>("/api/update/check", { method: "POST" }).catch((e) => ({ ...updates!, error: (e as Error).message }));
    checking = false; renderUpdates();
  });
  document.querySelector<HTMLButtonElement>("#updInstall")?.addEventListener("click", () => {
    if (!info) return;
    if (auto) { dialog().close(); install(info); } else window.open(info.notesUrl, "_blank", "noopener");
  });
  document.querySelector<HTMLInputElement>("#updAuto")?.addEventListener("change", async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    settings = await api<Settings>("/api/settings", { method: "POST", body: JSON.stringify({ checkUpdates: on }) });
    if (updates) updates.auto = on;
    toast(on ? "It looks for updates by itself" : "Only Check now looks for updates");
  });
}

/** Installing Ollama: on Windows the planner runs ollama.com's command and shows what it prints; elsewhere the command
 *  is shown to run in a terminal (it asks for the administrator password there). */
function installRow(i: OllamaInstall) {
  if (!i.canRun) return `<div class="set-row"><div><b>Install from a terminal</b><div class="hint">Ollama's installer asks for your password, so run it in Terminal:</div>
      <code class="set-path">${esc(i.command)}</code></div>
      <button type="button" class="btn" id="setCopyCmd">${icon("copy")} Copy</button></div>`;
  if (i.phase === "running") return `<div class="set-row"><div class="pull"><div class="bar indeterminate"><i></i></div>
      <div class="hint">Installing Ollama… ${esc(i.log.at(-1) || "downloading the installer")}</div></div></div>`;
  if (i.phase === "error") return `<div class="set-row"><div class="pull err">${icon("warn")} ${esc(i.error)}${i.log.length ? `<div class="hint">${esc(i.log.slice(-3).join(" · "))}</div>` : ""}</div>
      <a class="btn" href="https://ollama.com/download" target="_blank" rel="noopener">Download instead${ext()}</a></div>`;
  return `<div class="set-row"><div class="hint">Runs Ollama's own install command (<code>${esc(i.command)}</code>), which downloads and installs it from ollama.com.</div></div>`;
}

async function installOllama() {
  if (!setup || !confirm(`Install Ollama now?

This runs the command from ollama.com:
${setup.command}

It downloads Ollama (a large download) and installs it for your user.`)) return;
  try { setup = await api<OllamaInstall>("/api/ollama/install", { method: "POST" }); }
  catch (e) { toast((e as Error).message); return; }
  renderModels();
  clearInterval(setupPoll);
  setupPoll = window.setInterval(async () => {
    const now = await api<OllamaInstall>("/api/ollama/install").catch(() => null);
    if (!now) return;
    setup = now;
    if (now.phase === "running") { if (dialog().open) renderModels(); return; }
    clearInterval(setupPoll);
    if (now.phase === "done") { toast("Ollama is installed"); setup = null; await loadOllama(); refreshModels(); }
    else renderModels();
  }, 1500);
}

function renderModels() {
  const main = document.querySelector<HTMLElement>("#setMain");
  if (!main || tab !== "models" || find) return;
  const o = ollama, gpu = o?.gpu || null;
  const installed = new Set((o?.models || []).map((m) => m.name));
  const base = (name: string) => name.split(":")[0];
  const pullOf = (name: string) => o?.pulls.find((p) => p.name === name);
  const status = !o ? `<span class="dot"></span> Checking…`
    : o.running ? `<span class="dot ok"></span> Ollama is running${o.version ? ` <span class="hint">· version ${esc(o.version)}</span>` : ""}`
    : o.installed ? `<span class="dot warn"></span> Ollama is installed but not running`
    : `<span class="dot off"></span> Ollama isn't installed`;
  // How well a download fits the graphics card, with room for the context: comfortably, just (slower with long trips), or not.
  const usable = gpu ? (gpu.unified ? gpu.memGb * 0.65 : gpu.memGb) : 0;
  const fitGb = (gbs: number) => !gpu ? "" : gbs + Math.max(2.5, gbs * 0.15) <= usable ? `<span class="fit ok">Fits your GPU</span>`
    : gbs <= usable ? `<span class="fit warn">Tight</span>` : `<span class="fit bad">Too big for your GPU</span>`;
  const progress = (p: Pull) => {
    const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
    const secs = (Date.now() - p.started) / 1000, rate = secs > 2 && p.completed ? p.completed / secs : 0;
    return p.error ? `<div class="pull err">${icon("warn")} ${esc(p.error)}</div>`
      : p.done ? `<div class="pull ok"><span class="pop">${icon("check")}</span> Installed</div>`
      // Status and percentage, the bar, then size and speed with Cancel: each on its own line, so nothing wraps.
      : `<div class="pull">
          <div class="pull-head"><span class="pull-status"><span class="dl-arrow">${icon("download")}</span>${esc(p.status)}</span>${p.total ? `<b>${pct}%</b>` : ""}</div>
          <div class="bar${p.total ? "" : " indeterminate"}"><i style="width:${p.total ? Math.max(pct, 1) : 35}%"></i></div>
          <div class="pull-foot"><span>${p.total ? `${gb(p.completed)} of ${gb(p.total)}` : ""}${rate ? ` · ${(rate / 1024 ** 2).toFixed(0)} MB/s` : ""}</span>
            <button type="button" class="link-btn" data-cancel="${esc(p.name)}">Cancel</button></div></div>`;
  };
  const action = (name: string) => {
    const p = pullOf(name);
    if (p && !p.done) return progress(p);
    if (installed.has(name)) return `<span class="ok-text">${icon("check")} Installed</span>`;
    // Cancelled or failed: say so, next to the button to start it again.
    const cancelled = p?.error === "Cancelled";
    const note = p?.error ? `<span class="pull-note${cancelled ? "" : " err"}" title="${esc(p.error)}">${cancelled ? "Download cancelled" : `${icon("warn")} ${esc(p.error)}`}</span>` : "";
    // The same model under another tag ("qwen3.8:latest" for "qwen3.8:27b") is probably what they have already.
    const like = !note && (o?.models || []).find((m) => base(m.name) === base(name));
    return `${note}${like ? `<span class="hint have">You have ${esc(like.name)}</span>` : ""}<button type="button" class="btn" data-pull="${esc(name)}" ${o?.running ? "" : "disabled"}>${icon(p?.error && !cancelled ? "refresh" : "download")} ${p?.error && !cancelled ? "Try again" : "Install"}</button>`;
  };
  const capBadges = (caps: string[]) => caps.filter((c) => ["tools", "thinking", "vision"].includes(c)).map((c) => `<span class="cap">${esc(c)}</span>`).join("");

  // Recommended: from the library for this graphics card; the built-in list if ollama.com can't be read.
  const recRows = recs?.length ? recs.map((r, k) => `
      <div class="model-row${k === 0 ? " pick" : ""}">
        <div class="m-name"><code>${esc(r.tag)}</code>${k === 0 ? ` <span class="pick-badge">best for your GPU</span>` : ""} ${fitGb(r.sizeGb)} ${capBadges(r.caps)}
          <div class="hint">${esc(r.description)}</div>
          <div class="hint">${r.sizeGb} GB download${r.context ? ` · ${esc(r.context)} context` : ""} · ${count(r.downloads)} downloads</div></div>
        <div class="m-act">${action(r.tag)}</div>
      </div>`).join("")
    : MODELS.map((m) => {
      const pick = suggestion(gpu);
      return `<div class="model-row${pick?.tag === m.tag ? " pick" : ""}">
        <div class="m-name"><code>${m.tag}</code>${pick?.tag === m.tag ? ` <span class="pick-badge">best for your GPU</span>` : ""} ${fitGb(m.size)}
          <div class="hint">${esc(m.note)} · ${m.size.toFixed(1)} GB download</div></div>
        <div class="m-act">${action(m.tag)}</div></div>`;
    }).join("");

  // The library search.
  const capSeg = (c: string, label: string) => `<button type="button" class="seg${cap === c ? " on" : ""}" data-cap="${c}">${label}</button>`;
  const local = (results || []).filter((m) => !m.cloudOnly);
  const tagRows = (m: LibModel) => {
    const t = tagsOf.get(m.name);
    if (t === "loading" || !t) return `<p class="hint">Loading sizes…</p>`;
    if (t === "error") return `<p class="hint">Couldn't load the sizes. <a href="https://ollama.com/library/${esc(m.name)}/tags" target="_blank" rel="noopener">See them on ollama.com${ext()}</a></p>`;
    const shown = allVariants ? t : t.filter((x) => !/:latest$/.test(x.name) && !x.name.split(":")[1].includes("-"));
    return (shown.length ? shown : t).map((x) => `
      <div class="tag-row"><div><code>${esc(x.name)}</code> ${fitGb(x.sizeGb)}<div class="hint">${x.sizeGb} GB${x.context ? ` · ${esc(x.context)} context` : ""}${x.inputs ? ` · ${esc(x.inputs)}` : ""}</div></div>
        <div class="m-act">${action(x.name)}</div></div>`).join("");
  };
  const resultRows = local.map((m) => `
    <div class="lib-model${opened.has(m.name) ? " open" : ""}">
      <button type="button" class="lib-head" data-open="${esc(m.name)}">
        <div class="m-name"><code>${esc(m.name)}</code> ${capBadges(m.caps)}
          <div class="hint">${esc(m.description)}</div>
          <div class="hint">${[m.sizes.map(esc).join(", "), m.context ? `${esc(m.context)} context` : "", m.downloads ? `${count(m.downloads)} downloads` : "", m.updated ? `updated ${esc(m.updated)}` : ""].filter(Boolean).join(" · ")}</div></div>
        <span class="chev">${opened.has(m.name) ? "−" : "+"}</span>
      </button>
      ${opened.has(m.name) ? `<div class="lib-tags">${tagRows(m)}</div>` : ""}
    </div>`).join("");

  const others = (o?.pulls || []).filter((p) => (!p.done || p.error) && !recs?.some((r) => r.tag === p.name) && !MODELS.some((m) => m.tag === p.name)
    && !local.some((m) => opened.has(m.name) && p.name.startsWith(`${m.name}:`)));
  const mine = (o?.models || []).map((m) => `
    <div class="model-row">
      <div class="m-name"><code>${esc(m.name)}</code>${m.loaded ? ` <span class="fit ok">in memory</span>` : ""}
        <div class="hint">${[m.params, m.quant, gb(m.size)].filter(Boolean).map(esc).join(" · ")}</div></div>
      <div class="m-act"><button type="button" class="icon-btn" data-delete="${esc(m.name)}" title="Delete this model (frees ${gb(m.size)})">${icon("trash")}</button></div>
    </div>`).join("");
  const ctxOpts = [[0, "Automatic (as much as the trip needs)"], [16384, "16k tokens"], [32768, "32k tokens"], [65536, "64k tokens"], [131072, "128k tokens"], [196608, "192k tokens"], [262144, "256k tokens"]] as const;
  const searchFocused = document.activeElement?.id === "libQuery";
  main.innerHTML = `
    <h3>Local models <button type="button" class="icon-btn" id="setRefresh" title="Check again">${icon("refresh")}</button></h3>
    <div class="set-card">
      <div class="set-row"><div><b class="status">${status}</b>
        <div class="hint">${o?.running ? "Models run on your own computer: free and private." : o?.installed ? "The planner tries to start it; you can also open Ollama from the Start menu (or Applications on a Mac)." : "Ollama runs AI models on your own computer. Install it, then come back here to add a model."}</div></div>
        ${o && !o.installed && !setup?.canRun ? `<a class="btn solid" href="https://ollama.com/download" target="_blank" rel="noopener">Download Ollama${ext()}</a>` : ""}
        ${o && !o.installed && setup?.canRun && setup.phase !== "running" ? `<button type="button" class="btn solid" id="setInstallOllama">${icon("download")} Install Ollama</button>` : ""}</div>
      ${o && !o.installed && setup ? installRow(setup) : ""}
      <div class="set-row"><div><b>${icon("cpu")} Graphics card</b><div class="hint">${gpu ? `${esc(gpu.name)} · ${gpu.memGb} GB${gpu.unified ? " shared memory" : ""}` : "Not detected (an NVIDIA card is read with nvidia-smi). Models still run, more slowly, on the processor."}</div></div></div>
    </div>
    ${o?.models.length ? `<div class="set-card"><b class="card-title">Installed</b>${mine}</div>` : ""}
    <div class="set-card">
      <b class="card-title">Recommended</b>
      <p class="hint">${recs?.length ? `Current models from ollama.com that can plan (they use tools) and fit ${gpu?.memGb} GB, each in the biggest size that leaves room for long prompts.`
        : recs === null && !recsError ? "Finding models that fit your graphics card…" : `Built-in suggestions${recsError ? " (ollama.com couldn't be reached)" : ""}.`}</p>
      ${recRows}
    </div>
    <div class="set-card">
      <b class="card-title">Find models</b>
      <div class="lib-search"><span class="lib-search-icon">${icon("search")}</span>
        <input id="libQuery" type="search" placeholder="Search ollama.com: qwen, gemma, llama…" value="${esc(query)}"></div>
      <div class="lib-filters">
        <div class="segs">${capSeg("tools", "Can plan")}${capSeg("thinking", "Thinking")}${capSeg("vision", "Vision")}${capSeg("", "All")}</div>
        <label class="inline-check"><input type="checkbox" id="libVariants" ${allVariants ? "checked" : ""}> All variants</label>
      </div>
      <p class="hint lib-hint">"Can plan" models use tools, which the planner needs for its best results. Open a model to see its sizes; "All variants" also lists the quantizations (q8_0, bf16…).</p>
      ${searching ? `<p class="hint">Searching…</p>` : searchError ? `<p class="hint">${icon("warn")} ${esc(searchError)}</p>` : results && !local.length ? `<p class="hint">Nothing that runs locally matches.</p>` : resultRows}
      <div class="pull-other"><input id="setPullName" placeholder="Or a model by its exact name, e.g. llama3.3:70b or hf.co/user/repo"><button type="button" class="btn" id="setPullGo" ${o?.running ? "" : "disabled"}>${icon("download")} Install</button></div>
      ${others.map((p) => `<div class="model-row"><div class="m-name"><code>${esc(p.name)}</code></div><div class="m-act">${action(p.name)}</div></div>`).join("")}
    </div>
    ${localPlanHtml()}
    <div class="set-card">
      <div class="set-row"><div><b>Context size</b><div class="hint">How much a local model can read and write at once. Automatic sizes it for each trip; a fixed size uses that much every time (more needs more graphics memory, and the model's own limit still applies).</div></div>
        <select id="setCtx">${ctxOpts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
    </div>`;
  $("#setRefresh").onclick = () => { recs = null; recsError = ""; loadOllama(); loadRecs(); };
  const ctx = $<HTMLSelectElement>("#setCtx");
  ctx.value = String(settings?.numCtx || 0);
  ctx.onchange = async () => { settings = await api<Settings>("/api/settings", { method: "POST", body: JSON.stringify({ numCtx: +ctx.value }) }); toast("Saved: used for the next plan"); };
  wireTune(renderModels);
  const startPull = async (name: string) => {
    try { await api("/api/ollama/pull", { method: "POST", body: JSON.stringify({ name }) }); await loadOllama(); }
    catch (e) { toast((e as Error).message); }
  };
  document.querySelector<HTMLButtonElement>("#setInstallOllama")?.addEventListener("click", installOllama);
  document.querySelector<HTMLButtonElement>("#setCopyCmd")?.addEventListener("click", () => navigator.clipboard.writeText(setup?.command || "").then(() => toast("Copied the command")));
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
  // Search as you type (after a pause), or by capability.
  const q = $<HTMLInputElement>("#libQuery");
  if (searchFocused) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  let typing: number | undefined;
  q.oninput = () => { clearTimeout(typing); typing = window.setTimeout(() => { query = q.value.trim(); search(); }, 450); };
  $$<HTMLButtonElement>("#setMain [data-cap]").forEach((b) => { b.onclick = () => { cap = b.dataset.cap!; search(); }; });
  $$<HTMLButtonElement>("#setMain [data-open]").forEach((b) => {
    b.onclick = () => {
      const m = b.dataset.open!;
      if (opened.has(m)) opened.delete(m); else { opened.add(m); if (!tagsOf.has(m) || tagsOf.get(m) === "error") loadTags(m); }
      renderModels();
    };
  });
  $<HTMLInputElement>("#libVariants").onchange = (e) => { allVariants = (e.target as HTMLInputElement).checked; renderModels(); };
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
    ${l?.running ? awayCard(l) : ""}
    <div class="set-card">
      <b class="card-title">Good to know</b>
      <ul class="set-list">
        <li><b>Like an app:</b> on the phone, add the page to the home screen (iPhone: Share → Add to Home Screen; Android: ⋮ → Add to Home screen). On iPhone it then opens full-screen with its own icon.</li>
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
  document.querySelector<HTMLButtonElement>("#setAwayCheck")?.addEventListener("click", async () => { lan = await api<LanStatus>("/api/lan"); renderPhone(); });
}

/** Away from home: with Tailscale (a free private network) on this computer and the phone, the same planner works
 *  anywhere the phone has internet, without opening anything to the internet. A guide until it's set up, then the link. */
function awayCard(l: LanStatus) {
  const away = l.awayUrls?.[0];
  if (away) {
    const q = qrcode(0, "M"); q.addData(away); q.make();
    return `<div class="set-card">
      <b class="card-title">Away from home <span class="fit ok">Tailscale is on</span></b>
      <div class="phone-link">
        <div class="qr">${q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
        <div>
          <b>The planner from anywhere</b>
          <p class="hint">With Tailscale on the phone, this link works wherever it has internet, while this computer is on with the planner running. Scan it once (it's a separate link from the home one).</p>
          ${(l.awayUrls || []).map((u) => `<div class="link-row"><code>${esc(u)}</code><button type="button" class="icon-btn" data-copy="${esc(u)}" title="Copy">${icon("copy")}</button></div>`).join("")}
        </div>
      </div>
    </div>`;
  }
  const pc = l.platform === "darwin" ? ["https://tailscale.com/download/mac", "Download for Mac"]
    : l.platform === "linux" ? ["https://tailscale.com/download/linux", "Install on Linux"]
      : ["https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe", "Download for Windows"];
  return `<div class="set-card">
    <b class="card-title">Away from home</b>
    <p class="hint">To use the planner while you're out (say, on the trip), connect this computer and your phone with <b>Tailscale</b>: a free private network between your own devices. Nothing is opened to the internet, and it takes a few minutes:</p>
    <ol class="set-steps">
      <li><b>On this computer:</b> install Tailscale and sign in (with Google, Microsoft, Apple or GitHub). ${l.tailscale ? `<span class="fit ok">installed</span>` : `<a class="btn" href="${pc[0]}" target="_blank" rel="noopener">${icon("download")} ${pc[1]}</a>`}</li>
      <li><b>On your phone:</b> install the Tailscale app and sign in with the same account.
        <span class="set-inline"><a class="link-btn" href="https://apps.apple.com/app/tailscale/id1470499037" target="_blank" rel="noopener">App Store${ext()}</a><a class="link-btn" href="https://play.google.com/store/apps/details?id=com.tailscale.ipn" target="_blank" rel="noopener">Google Play${ext()}</a></span></li>
      <li><b>Back here:</b> the away-from-home link and its QR code show up in this place. <button type="button" class="link-btn" id="setAwayCheck">${icon("refresh")} Check again</button></li>
    </ol>
    <p class="hint">The computer has to stay on with the planner running (sleep off while you travel). Tailscale's free plan is enough.</p>
  </div>`;
}

export function initSettings() {
  $("#settingsBtn").onclick = () => openSettings();
  dialog().addEventListener("close", () => {
    if (keysChanged) onKeysClosed?.();
    keysChanged = false; onKeysClosed = null;
  });
}
