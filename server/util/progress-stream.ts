// A response that streams progress as one JSON object per line (status texts, token counts), then the result.
import type { Res } from "./http";

export type Progress = { type: "status"; text: string } | { type: "tokens"; n: number };
export type Report = (ev: Progress) => void;

/** Runs `work` while streaming its progress to the browser; ends with {type:"done", result} or {type:"error", error}. */
export async function streamProgress<T>(res: Res, work: (report: Report) => Promise<T>) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
  const send = (ev: object) => { try { res.write(`${JSON.stringify(ev)}\n`); } catch { /* browser gone */ } };
  let lastTokens = 0;
  const report: Report = (ev) => {
    // Token counts arrive per token; send at most every 10 so the line stays light.
    if (ev.type === "tokens" && ev.n - lastTokens < 10) return;
    if (ev.type === "tokens") lastTokens = ev.n;
    send(ev);
  };
  try { send({ type: "done", result: await work(report) }); }
  catch (e) { send({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
  res.end();
}
