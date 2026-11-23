// Settings → Planning: sets up a private SearXNG for local models' research, in Docker on this computer, and points
// research at it; or takes it all away again. It runs in the background, so the page polls GET /api/searxng.
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, errMsg, sleep } from "../config";
import { readSettings, writeSettings } from "../settings";
import { type Req, type Res, sendJson } from "../util/http";

const NAME = "trip-planner-searxng";
const IMAGE = "searxng/searxng:latest";
const PORT = 47616;
export const SEARXNG_LOCAL = `http://127.0.0.1:${PORT}`;
const DIR = path.join(ROOT, "searxng");

/** Where a set-up or start is: the page shows these as steps (Docker installed, Docker running, SearXNG downloaded,
 *  running, answering). */
type Stage = "docker-install" | "docker-start" | "pull" | "run" | "wait" | "remove";
interface Job { action: "install" | "start" | "uninstall"; step: string; stage?: Stage; done: boolean; error?: string }
let job: Job | null = null;

const DESKTOP_DIR = path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker");
/** Docker's command: its full path on Windows, so it's found right after installing (before PATH is refreshed). */
const dockerBin = () => {
  const full = path.join(DESKTOP_DIR, "resources", "bin", "docker.exe");
  return process.platform === "win32" && fs.existsSync(full) ? full : "docker";
};

const docker = (args: string[], ms = 20000) => new Promise<string>((resolve, reject) =>
  execFile(dockerBin(), args, { timeout: ms, windowsHide: true, maxBuffer: 4 << 20 }, (err, out, errOut) =>
    err ? reject(new Error((errOut || err.message).trim().split("\n").pop() || "docker failed")) : resolve(out.trim())));

/** "missing": no Docker; "stopped": Docker is installed but its engine isn't running; "ok". */
export async function dockerState(): Promise<"missing" | "stopped" | "ok"> {
  try { await docker(["version", "--format", "{{.Server.Version}}"], 8000); return "ok"; }
  catch (e) { return /not recognized|ENOENT|not found/i.test(errMsg(e)) ? "missing" : "stopped"; }
}

/** Starts Docker Desktop on Windows and waits up to two minutes for its engine. */
async function startDocker() {
  const exe = path.join(DESKTOP_DIR, "Docker Desktop.exe");
  if (process.platform !== "win32" || !fs.existsSync(exe)) throw new Error("Docker isn't running: start Docker, then try again");
  spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 60; i++) { await sleep(2000); if ((await dockerState()) === "ok") return; }
  throw new Error("Docker Desktop didn't start in time: open it, wait until it says it's running, then try again");
}

/** Installs Docker Desktop with winget (Windows asks for permission). It may need WSL and a restart before it runs. */
async function installDocker(j: Job) {
  if (process.platform !== "win32") throw new Error("Docker isn't installed: install Docker (docker.com), then try again");
  j.stage = "docker-install";
  j.step = "Installing Docker Desktop (Windows will ask for permission; this takes a few minutes)…";
  await new Promise<void>((resolve, reject) => execFile("winget", ["install", "-e", "--id", "Docker.DockerDesktop", "--silent",
    "--accept-package-agreements", "--accept-source-agreements"], { timeout: 30 * 60 * 1000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) =>
    err && !fs.existsSync(path.join(DESKTOP_DIR, "Docker Desktop.exe"))
      ? reject(new Error(/not recognized|ENOENT/i.test(err.message) ? "Couldn't install Docker: winget is missing. Get Docker Desktop from docker.com, then try again"
        : `Couldn't install Docker Desktop: ${String(out || err.message).trim().split("\n").pop()}`))
      : resolve()));
  j.stage = "docker-start"; j.step = "Starting Docker for the first time…";
  try { await startDocker(); }
  catch { throw new Error("Docker Desktop is installed. Restart the computer, open Docker Desktop once and accept its terms, then press Set up again"); }
}

export const containerState = async () => { try { return await docker(["inspect", "-f", "{{.State.Status}}", NAME], 8000); } catch { return ""; } };

/** Answers a JSON search? (Fresh SearXNG takes a few seconds to start.) */
async function answers() {
  try { const r = await fetch(`${SEARXNG_LOCAL}/search?q=kyoto&format=json`, { signal: AbortSignal.timeout(8000) }); return r.ok; } catch { return false; }
}

function writeConfig() {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, "settings.yml");
  if (fs.existsSync(file)) return;
  // The defaults, plus the JSON format research needs; no rate limiter (only this computer can reach it).
  fs.writeFileSync(file, [
    "use_default_settings: true",
    "server:",
    `  secret_key: "${crypto.randomBytes(24).toString("hex")}"`,
    "  limiter: false",
    "  image_proxy: false",
    "search:",
    "  formats:",
    "    - html",
    "    - json",
    "",
  ].join("\n"));
}

/** Sets SearXNG up, or (start) only starts Docker and SearXNG again: a start never installs Docker by itself. */
async function install(j: Job) {
  const state = await dockerState();
  if (state === "missing" && j.action === "start") throw new Error("Docker isn't installed: press Set up to install it");
  if (state === "missing") await installDocker(j);
  if (state === "stopped") { j.stage = "docker-start"; j.step = "Starting Docker…"; await startDocker(); }
  writeConfig();
  if (!(await containerState())) {
    j.stage = "pull"; j.step = "Downloading SearXNG (about 200 MB)…";
    await docker(["pull", IMAGE], 15 * 60 * 1000);
    j.stage = "run"; j.step = "Starting SearXNG…";
    // Only this computer can reach it; it starts again with Docker.
    await docker(["run", "-d", "--name", NAME, "--restart", "unless-stopped", "-p", `127.0.0.1:${PORT}:8080`,
      "-v", `${DIR}:/etc/searxng`, IMAGE], 60000);
  } else {
    j.stage = "run"; j.step = "Starting SearXNG…";
    await docker(["start", NAME]);
  }
  j.stage = "wait"; j.step = "Waiting for SearXNG to answer…";
  for (let i = 0; i < 45 && !(await answers()); i++) await sleep(2000);
  if (!(await answers())) throw new Error("SearXNG started but doesn't answer searches yet: try Set up again in a minute");
  // Set up: research uses it from now on. A start leaves the settings as they are.
  if (j.action === "install") writeSettings({ searxngUrl: SEARXNG_LOCAL, tune: { search: "searxng" } });
}

async function uninstall(j: Job) {
  if ((await dockerState()) === "ok") {
    j.stage = "remove"; j.step = "Removing SearXNG…";
    await docker(["rm", "-f", NAME]).catch(() => {});
    await docker(["rmi", IMAGE], 60000).catch(() => {}); // kept if something else uses it
  } else if (fs.existsSync(DIR)) throw new Error("Docker isn't running: start it so SearXNG can be removed, then try again");
  fs.rmSync(DIR, { recursive: true, force: true });
  const s = readSettings();
  if (s.searxngUrl === SEARXNG_LOCAL) writeSettings({ searxngUrl: "", tune: s.tune.search === "searxng" ? { search: "auto" } : undefined });
}

let ensuring: Promise<boolean> | null = null, lastEnsure = 0;
/** Research is about to use the local SearXNG and it doesn't answer: start Docker and it (at most once every 5 minutes). */
export function ensureSearxng(): Promise<boolean> {
  if (ensuring) return ensuring;
  if (Date.now() - lastEnsure < 5 * 60 * 1000 || (job && !job.done) || !fs.existsSync(DIR)) return Promise.resolve(false);
  lastEnsure = Date.now();
  return ensuring = (async () => {
    try {
      if (await answers()) return true;
      if ((await dockerState()) === "missing") return false;
      // As a job, so Settings and the quick-start guide show its steps while it starts.
      run("start");
      while (job && !job.done) await sleep(1000);
      return !job?.error;
    } catch { return false; } finally { ensuring = null; }
  })();
}

function run(action: Job["action"]) {
  if (job && !job.done) return;
  const j: Job = job = { action, step: "Checking Docker…", done: false };
  (action === "uninstall" ? uninstall(j) : install(j))
    .then(() => { j.step = action === "install" ? "SearXNG is set up" : action === "start" ? "SearXNG is running" : "SearXNG is removed"; })
    .catch((e) => { j.error = errMsg(e); })
    .finally(() => { j.done = true; });
}

/** Research is set to use SearXNG on this computer: start Docker and it with the app (in the background). */
export function startSearxngIfChosen() {
  const s = readSettings();
  if (fs.existsSync(DIR) && s.searxngUrl === SEARXNG_LOCAL && s.tune.search !== "brave") ensureSearxng().catch(() => {});
}

/** Everything the page shows about SearXNG on this computer (also the quick-start guide's Docker and SearXNG rows). */
export async function searxngInfo() {
  const busy = !!job && !job.done;
  const [dockerNow, container] = await Promise.all([dockerState(), containerState()]);
  return {
    installed: fs.existsSync(DIR), linked: readSettings().searxngUrl === SEARXNG_LOCAL,
    running: container === "running", container, docker: dockerNow, busy, platform: process.platform, job,
  };
}

export async function handleSearxng(req: Req, res: Res, p: string) {
  if (req.method === "POST" && p === "/api/searxng/install") run("install");
  else if (req.method === "POST" && p === "/api/searxng/start") run("start");
  else if (req.method === "POST" && p === "/api/searxng/uninstall") run("uninstall");
  sendJson(res, 200, await searxngInfo());
}
