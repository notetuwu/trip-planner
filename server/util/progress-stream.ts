// A response that streams progress as one JSON object per line (status texts, token counts), then the result.
import type { Res } from "./http";

export type Progress = { type: "status"; text: string } | { type: "tokens"; n: number } | { type: "reasoning"; text: string };
export type Report = (ev: Progress) => void;

/**
 * Runs `work` while streaming its progress to the browser; ends with {type:"done", result} or {type:"error", error}.
 * If the browser goes away (Cancel), `signal` aborts and the next report throws, so the work stops early.
 */
export async function streamProgress<T>(res: Res, work: (report: Report, signal: AbortSignal) => Promise<T>) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
  const send = (ev: object) => { try { res.write(`${JSON.stringify(ev)}\n`); } catch { /* browser gone */ } };
  let lastTokens = 0, finished = false, lastReasoning = 0, heldReasoning: Progress | null = null;
  const flush = () => { if (heldReasoning) { send(heldReasoning); heldReasoning = null; lastReasoning = Date.now(); } };
  const cancel = new AbortController();
  res.on("close", () => { if (!finished) cancel.abort(new Error("Cancelled")); });
  const report: Report = (ev) => {
    if (cancel.signal.aborted) throw new Error("Cancelled");
    // The reasoning so far, at most every half second.
    if (ev.type === "reasoning") { heldReasoning = ev; if (Date.now() - lastReasoning >= 500) flush(); return; }
    if (ev.type === "status") flush();
    // Token counts arrive per token; send at most every 10 so the line stays light.
    if (ev.type === "tokens" && ev.n - lastTokens < 10) return;
    if (ev.type === "tokens") lastTokens = ev.n;
    send(ev);
  };
  try { const result = await work(report, cancel.signal); flush(); send({ type: "done", result }); }
  catch (e) { send({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
  finished = true;
  res.end();
}
