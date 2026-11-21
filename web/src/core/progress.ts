// Reads a streamed helper request (stops on the way, route planning): one JSON line per update — status texts and the
// model's token count — then the result. A ticking timer keeps the line alive while the model thinks.
import { apiFetch } from "./dom";

export interface Live { status: string; tokens: number; seconds: number; reasoning: string }

/** `signal` cancels it (the server notices the closed connection and stops too). */
export async function streamRequest<T>(url: string, body: unknown, onUpdate: (live: Live) => void, signal?: AbortSignal): Promise<T> {
  const live: Live = { status: "Starting…", tokens: 0, seconds: 0, reasoning: "" };
  const t0 = Date.now();
  const timer = setInterval(() => { live.seconds = Math.round((Date.now() - t0) / 1000); onUpdate(live); }, 1000);
  onUpdate(live);
  try {
    const res = await apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The server stopped before it was done.");
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "error") throw new Error(ev.error);
        if (ev.type === "done") return ev.result as T;
        if (ev.type === "status") live.status = ev.text;
        if (ev.type === "tokens") live.tokens = ev.n;
        if (ev.type === "reasoning") live.reasoning = ev.text;
        onUpdate(live);
      }
    }
  } finally { clearInterval(timer); }
}

/** "Choosing towns… · 120 tokens · 14 s" */
export const liveText = (l: Live) => `${l.status}${l.tokens ? ` · ${l.tokens.toLocaleString()} tokens` : ""}${l.seconds ? ` · ${l.seconds} s` : ""}`;
