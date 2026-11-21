// The built page: from dist/web next to the server, or, in the packaged app, from the files baked into it.
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { getAsset } from "node:sea";
import { PACKAGED } from "./config";

/** The built app sits next to this file's folder: dist/server/main.js -> dist/web. */
const WEB_DIR = path.resolve(import.meta.dirname || ".", "../web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function read(rel: string): Buffer | null {
  if (PACKAGED) {
    try { return Buffer.from(getAsset(`web/${rel}`)); } catch { return null; }
  }
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return null;
  try { return fs.readFileSync(file); } catch { return null; }
}

export const hasBuiltApp = () => !!read("index.html");

export function serveStatic(pathname: string, res: http.ServerResponse) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  if (rel.split(/[\\/]/).includes("..")) return res.writeHead(403).end();
  const data = read(rel);
  if (!data) return res.writeHead(404).end("Not found");
  // Built assets have content hashes in their names, so they can be cached for good.
  const immutable = pathname.startsWith("/assets/") ? { "Cache-Control": "public, max-age=31536000, immutable" } : {};
  res.writeHead(200, { "Content-Type": MIME[path.extname(rel)] || "application/octet-stream", ...immutable });
  res.end(data);
}
