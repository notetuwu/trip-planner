// Production server: the built app plus the API. `npm start` runs it from dist/ on http://localhost:5173; the
// packaged app (one executable, see scripts/package.mjs) runs the same code, opens its own window and quits when
// that window is closed.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { handleApi, startup } from "./api";
import { PACKAGED, PORT, ROOT } from "./config";
import { alreadyRunning, openWindow, quitWhenClosed } from "./launcher";
import { hasBuiltApp, serveStatic } from "./static";

const url = `http://localhost:${PORT}`;

// The packaged app has no console window: its messages go to a log file in the data folder.
if (PACKAGED) {
  fs.mkdirSync(ROOT, { recursive: true });
  const log = fs.createWriteStream(path.join(ROOT, "trip-planner.log"), { flags: "w" });
  const write = (...args: unknown[]) => log.write(`${new Date().toISOString()} ${args.map(String).join(" ")}\n`);
  console.log = console.warn = console.error = write;
  process.on("uncaughtException", (e) => write("Uncaught:", e?.stack || e));
}

const server = http.createServer(async (req, res) => {
  // Allow the page to be opened from file:// (origin "null") as well as from this server.
  const origin = req.headers.origin;
  if (origin === "null" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "")) {
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  }
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (await handleApi(req, res)) return;
  if (req.method === "GET") return serveStatic(new URL(req.url || "/", "http://x").pathname, res);
  res.writeHead(405).end();
});

async function main() {
  // Started again while running: just open another window.
  if (PACKAGED && await alreadyRunning(url)) {
    openWindow(url, ROOT);
    return setTimeout(() => process.exit(0), 3000);
  }
  if (!hasBuiltApp()) console.warn(`No built app found; run "npm run build" first.`);
  startup();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Trip planner running at ${url} (data in ${ROOT})`);
    if (PACKAGED) {
      const window = process.env.TRIP_PLANNER_NO_WINDOW ? null : openWindow(url, ROOT);
      quitWhenClosed(window, () => { console.log("The app was closed, quitting."); process.exit(0); });
    }
  });
  server.on("error", (e) => { console.error(`Could not start on port ${PORT}: ${e.message}`); process.exit(1); });
}

main();
