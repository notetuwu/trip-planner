// Small helpers for the plain Node HTTP server.
import type { IncomingMessage, ServerResponse } from "node:http";

export type Req = IncomingMessage;
export type Res = ServerResponse;

export function sendJson(res: Res, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function readBody(req: Req): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve(body));
  });
}

export async function readJson(req: Req): Promise<any> {
  try { return JSON.parse(await readBody(req)); } catch { return null; }
}

/** Reads a streaming HTTP body (e.g. fetch's response.body) line by line. */
export async function* lines(body: AsyncIterable<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) yield buf;
}

/** Fetches JSON with a short timeout (used to probe local model servers). */
export async function getJson(url: string, ms = 800): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
