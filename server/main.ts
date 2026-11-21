// Production server: the built app from dist/web plus the API, on http://localhost:5173.
// Build first with `npm run build`, then `npm start` (or just `python start.py`, which does both).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { handleApi, startup } from "./api";
import { PORT } from "./config";

/** The built app sits next to this file's folder: dist/server/main.js -> dist/web. */
const WEB_DIR = path.resolve(import.meta.dirname, "../web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function serveStatic(pathname: string, res: http.ServerResponse) {
  const file = path.join(WEB_DIR, pathname === "/" ? "index.html" : decodeURIComponent(pathname));
  if (!file.startsWith(WEB_DIR)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("Not found");
    // Built assets have content hashes in their names, so they can be cached for good.
    const immutable = pathname.startsWith("/assets/") ? { "Cache-Control": "public, max-age=31536000, immutable" } : {};
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", ...immutable });
    res.end(data);
  });
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

if (!fs.existsSync(path.join(WEB_DIR, "index.html"))) console.warn(`No built app in ${WEB_DIR}; run "npm run build" first.`);
startup();
server.listen(PORT, "127.0.0.1", () => console.log(`Trip planner running at http://localhost:${PORT}`));
