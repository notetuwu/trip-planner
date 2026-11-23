// SearXNG on this computer, as steps: Docker installed → Docker running → SearXNG downloaded → running → answering
// searches. Each step shows done, busy (spinning), waiting or failed, with the one button that gets it further (set it
// up, start it, use it). Settings → Planning and the quick-start guide both show it; it follows a set-up or start
// running in the background until it's done.
import { api, esc, toast } from "../core/dom";
import { ext, icon } from "../core/icons";

export interface SearxngInfo {
  installed: boolean;
  linked: boolean;
  running: boolean;
  container: string;
  docker: "missing" | "stopped" | "ok";
  busy: boolean;
  platform: string;
  job: { action: "install" | "start" | "uninstall"; step: string; stage?: string; done: boolean; error?: string } | null;
}

type StepState = "done" | "active" | "todo" | "error";
const STEPS = [
  { stage: "docker-install", label: "Docker installed", hint: "Runs SearXNG in a sealed box" },
  { stage: "docker-start", label: "Docker running", hint: "Started with the planner when needed" },
  { stage: "pull", label: "SearXNG downloaded", hint: "About 200 MB, once" },
  { stage: "run", label: "SearXNG running", hint: "Only this computer can reach it" },
  { stage: "wait", label: "Answering searches", hint: "Research goes through it" },
];

/** Each step's state: from what's there now, or while a set-up or start runs, from where it has got to. */
export function stepStates(s: SearxngInfo): StepState[] {
  const there = [s.docker !== "missing", s.docker === "ok", !!s.container || s.running, s.running, s.running && s.linked];
  const job = s.job;
  const at = job && job.action !== "uninstall" ? STEPS.findIndex((x) => x.stage === job.stage) : -1;
  if (job && !job.done && at >= 0) return STEPS.map((_, i) => (i < at ? "done" : i === at ? "active" : there[i] ? "done" : "todo"));
  if (job?.done && job.error && at >= 0) return STEPS.map((_, i) => (i < at ? "done" : i === at ? "error" : "todo"));
  return there.map((t) => (t ? "done" : "todo"));
}

const stepIcon = (st: StepState, n: number) => st === "done" ? `<svg class="sx-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`
  : st === "active" ? `<span class="sx-spin"></span>` : st === "error" ? icon("warn") : `<span>${n}</span>`;

export function searxngHtml(s: SearxngInfo | null, compact = false) {
  if (!s) return `<div class="sx-panel loading"><span class="sx-spin"></span> Checking Docker and SearXNG…</div>`;
  const states = stepStates(s), job = s.job, busy = !!job && !job.done;
  const done = states.filter((x) => x === "done").length;
  const steps = STEPS.map((x, i) => `<li class="sx-step ${states[i]}" style="--i:${i}">
      <span class="sx-icon">${stepIcon(states[i], i + 1)}</span>
      <span class="sx-label"><b>${x.label}</b>${compact ? "" : `<small>${x.hint}</small>`}</span></li>`).join("");
  const noAutoDocker = s.docker === "missing" && s.platform !== "win32";
  let msg = "", act = "";
  if (busy) msg = `<span class="sx-spin small"></span> ${esc(job!.step)}`;
  else if (job?.error) {
    msg = `<span class="sx-err">${icon("warn")} ${esc(job.error)}</span>`;
    act = `<button type="button" class="btn" data-sx="${s.installed ? "start" : "install"}">${icon("refresh")} Try again</button>`;
  } else if (s.running && s.linked) msg = `<span class="sx-ok">${icon("check")} Ready: research searches through SearXNG on this computer.</span>`;
  else if (s.running) { msg = "SearXNG runs here, but research uses another address."; act = `<button type="button" class="btn solid" data-sx="install">Use it for research</button>`; }
  else if (s.installed) { msg = s.docker === "missing" ? "Docker is gone, so SearXNG can't run." : `Set up, but ${s.docker === "ok" ? "SearXNG" : "Docker"} isn't running.`; act = s.docker === "missing" ? `<button type="button" class="btn solid" data-sx="install">${icon("download")} Install Docker again</button>` : `<button type="button" class="btn solid" data-sx="start">${icon("power")} Start Docker and SearXNG</button>`; }
  else if (noAutoDocker) { msg = "Install Docker Desktop first, start it once, then set SearXNG up here."; act = `<a class="btn" href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noopener">${icon("download")} Get Docker Desktop${ext()}</a><button type="button" class="btn solid" data-sx="install">Set up SearXNG</button>`; }
  else {
    msg = s.docker === "missing" ? "Installs Docker Desktop (Windows asks for permission; a restart may be needed), then SearXNG." : "Docker is here: this only downloads and starts SearXNG.";
    act = `<button type="button" class="btn solid" data-sx="install">${icon("download")} Set up SearXNG</button>`;
  }
  const remove = !busy && s.installed ? `<button type="button" class="link-btn sx-remove" data-sx="uninstall" title="Remove the container, its download and its settings">Remove</button>` : "";
  return `<div class="sx-panel${busy ? " busy" : ""}" style="--progress:${done / STEPS.length}">
    <ol class="sx-steps">${steps}</ol>
    <div class="sx-foot"><span class="sx-msg">${msg}</span><span class="sx-acts">${act}${remove}</span></div>
  </div>`;
}

/**
 * Shows the panel in `el` and keeps it up to date while something runs. autoStart: SearXNG is what research uses, so
 * if it's set up but stopped, Docker and it are started straight away. onChange runs when a set-up, start or removal
 * finishes (the settings may have changed).
 */
export function mountSearxng(el: HTMLElement, opts: { autoStart?: boolean; compact?: boolean; onChange?: (s: SearxngInfo) => void } = {}) {
  let timer: number | undefined, last: SearxngInfo | null = null, started = false;
  const draw = (s: SearxngInfo | null) => {
    el.innerHTML = searxngHtml(s, opts.compact);
    el.querySelectorAll<HTMLButtonElement>("[data-sx]").forEach((b) => {
      b.onclick = () => {
        const action = b.dataset.sx!;
        if (action === "uninstall" && !confirm("Remove SearXNG from this computer? (Docker stays.)")) return;
        act(action);
      };
    });
  };
  const act = async (action: string) => {
    try { tick(await api<SearxngInfo>(`/api/searxng/${action}`, { method: "POST" })); } catch (e) { toast((e as Error).message); }
  };
  const tick = (s: SearxngInfo) => {
    const wasBusy = !!last?.job && !last.job.done;
    last = s; draw(s);
    const busy = !!s.job && !s.job.done;
    if (wasBusy && !busy) { toast(s.job?.error || s.job?.step || "Done"); opts.onChange?.(s); }
    clearTimeout(timer);
    if (busy) timer = window.setTimeout(load, 1200);
    // Chosen for research but not running: start it (once per showing).
    if (opts.autoStart && !started && !busy && s.installed && !s.running && s.docker !== "missing" && !s.job?.error) { started = true; act("start"); }
  };
  const load = async () => {
    if (!el.isConnected) return;
    try { tick(await api<SearxngInfo>("/api/searxng")); }
    catch { el.innerHTML = `<div class="sx-panel"><span class="sx-err">${icon("warn")} Couldn't check SearXNG</span></div>`; }
  };
  draw(null);
  load();
}
