// Browser tests' helpers: start the built app (temporary data folder) and a headless Chrome/Edge, and drive the page
// over the DevTools protocol. No test framework beyond node:test, no browser download (uses the installed one).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** The installed Chrome, Chromium or Edge (CHROME_PATH wins). */
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("No Chrome, Chromium or Edge found; set CHROME_PATH.");
  return found;
}

async function waitFor(fn, ms = 15000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

/** Starts the app (from dist/, so run `npm run build` first) and a browser; returns a page handle and stop(). */
export async function launch() {
  if (!fs.existsSync(path.join(ROOT, "dist/server/main.js"))) throw new Error('No build in dist/: run "npm run build" first.');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "trip-planner-e2e-"));
  const [appPort, cdpPort] = [await freePort(), await freePort()];
  const app = spawn(process.execPath, [path.join(ROOT, "dist/server/main.js")], {
    env: { ...process.env, PORT: String(appPort), TRIP_PLANNER_DATA: data, TRIP_PLANNER_NO_WINDOW: "1" }, stdio: "ignore",
  });
  const base = `http://localhost:${appPort}`;
  await waitFor(() => fetch(`http://127.0.0.1:${appPort}/api/health`).then((r) => r.ok), 20000, "the app to start");

  const browser = spawn(findBrowser(), [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(data, "browser")}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1500,950", "about:blank",
  ], { stdio: "ignore" });
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === "page"), 20000, "the browser");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Page.enable");

  const page = {
    base, errors,
    /** Runs an expression (or async IIFE) in the page and returns its value. */
    async eval(expr) {
      const r = (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result;
      if (r.exceptionDetails) throw new Error(`In page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    /** Code that runs before the app's own scripts on every load (stubs). */
    addInitScript: (source) => send("Page.addScriptToEvaluateOnNewDocument", { source }),
    async goto(url = base) {
      await send("Page.navigate", { url });
      await waitFor(() => page.eval("document.readyState === 'complete' && !!window.planner"), 20000, "the page to load");
    },
    waitFor: (expr, ms, what) => waitFor(() => page.eval(expr), ms, what || expr),
    /** Makes the page this many CSS pixels wide and high (like a smaller window or a phone). */
    setViewport: (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
    /** Saves a PNG of the page, or of an element (CSS selector) scrolled into view. */
    async screenshot(file, selector) {
      let clip;
      if (selector) {
        const r = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" });
          const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
        clip = { ...r, scale: 1 };
      }
      const msg = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
      fs.writeFileSync(file, Buffer.from(msg.result.data, "base64"));
    },
    sleep,
  };

  const stop = () => {
    try { ws.close(); } catch { /* closed */ }
    browser.kill(); app.kill();
    setTimeout(() => fs.rmSync(data, { recursive: true, force: true }), 1000).unref();
  };
  return { page, stop };
}
