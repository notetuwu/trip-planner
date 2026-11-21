// The live view while a plan is generated: status line, timer, token speed, progress bar, reasoning and prompt panels.
import type { Poi, StreamEvent } from "../../../shared/types";
import { $, esc } from "../core/dom";
import type { Lookup, PromptPart } from "../core/state";
import { promptBody, promptHtml, promptSummary, thoughtsBody, thoughtsHtml } from "../itinerary/panels";

export interface ProgressView {
  onEvent(ev: StreamEvent): void;
  /** What was collected, kept with the finished itinerary. */
  collected: { lookups: Lookup[]; prompt: PromptPart[]; pois: Poi[] };
  stop(): void;
}

export function showProgress(o: { who: string; revising: boolean; local: boolean; expectedDays: number; onCancel(): void }): ProgressView {
  // Built once and then updated in place, so an opened reasoning panel stays open.
  const out = $("#output");
  out.innerHTML = `
    <div class="empty loading">
      <div class="sun"></div>
      ${esc(o.who)} is ${o.revising ? "revising" : "planning"} your trip… <span data-gen-time>0s</span>
      <small data-gen-status>${o.local ? "Loading the model…" : "Starting…"}</small>
      <small data-gen-tokens class="gen-tokens"></small>
      <div class="gen-bar"><i data-gen-bar></i></div>
      <small>${o.local ? "Local models can take several minutes, depending on your hardware." : "This usually takes 1–3 minutes."}</small>
      <button class="btn" data-gen-cancel style="margin-top:14px">Cancel</button>
    </div>
    ${thoughtsHtml("", { live: true })}
    ${promptHtml([])}`;
  const el = (k: string) => out.querySelector<HTMLElement>(`[data-${k}]`)!;
  el("gen-cancel").onclick = o.onCancel;
  const status = (s: string) => { el("gen-status").textContent = s; };

  let notes = "", thinking = "", notesFrame = 0;
  const collected = { lookups: [] as Lookup[], prompt: [] as PromptPart[], pois: [] as Poi[] };
  // Live output-token count. The speed is measured over the last few seconds only, so pauses (web searches, page
  // reads, reading the prompt) don't drag it down; during a pause it says "waiting" instead.
  let tokens = 0, estimated = false, finalRate = 0, samples: { t: number; n: number }[] = [];
  const showTokens = () => {
    if (!tokens) return;
    const now = Date.now();
    samples = samples.filter((s) => now - s.t < 5000);
    const last = samples.at(-1), first = samples[0];
    let speed = "";
    if (finalRate) speed = ` · ${Math.round(finalRate)} tok/s`;
    else if (!last || now - last.t > 2000) speed = " · waiting…";
    else if (last.t - first.t > 800) speed = ` · ${Math.round((last.n - first.n) / ((last.t - first.t) / 1000))} tok/s`;
    el("gen-tokens").textContent = `${estimated ? "~" : ""}${tokens.toLocaleString()} tokens${speed}`;
  };
  const t0 = Date.now();
  const timer = setInterval(() => { el("gen-time").textContent = `${Math.round((Date.now() - t0) / 1000)}s`; showTokens(); }, 1000);

  // Re-render the reasoning at most once per frame. It follows the newest line only while you're at the bottom;
  // scroll up to read and it stays put.
  const renderNotes = () => {
    el("thoughts-hint").textContent = "";
    notesFrame ||= requestAnimationFrame(() => {
      notesFrame = 0;
      const body = el("thoughts-body");
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      const top = body.scrollTop;
      body.innerHTML = thoughtsBody(notes, thinking, collected.lookups);
      body.scrollTop = atBottom ? body.scrollHeight : top;
    });
  };

  function onEvent(ev: StreamEvent) {
    switch (ev.type) {
      case "thinking": status(`Thinking… ~${ev.tokens >= 1000 ? (ev.tokens / 1000).toFixed(1) + "k" : ev.tokens} tokens`); break;
      // Claude streams its notes piece by piece; local models stream real thinking, then the notes field as it grows.
      case "text": notes += ev.text; status("Writing planning notes…"); renderNotes(); break;
      case "notes": notes = ev.text; status("Writing planning notes…"); renderNotes(); break;
      case "thought": thinking += ev.text; status(`Thinking… ${thinking.length.toLocaleString()} characters`); renderNotes(); break;
      case "status": status(ev.text); break;
      case "pois": collected.pois = ev.places; break;
      case "prompt":
        collected.prompt.push({ label: ev.label, info: ev.info, text: ev.text });
        el("prompt-summary").textContent = promptSummary(collected.prompt);
        // Append rather than re-render, so an open panel keeps its scroll position.
        el("prompt-body").insertAdjacentHTML("beforeend", promptBody([collected.prompt.at(-1)!]));
        break;
      case "tokens":
        tokens = ev.count; estimated = ev.estimated; finalRate = ev.perSec || 0;
        samples.push({ t: Date.now(), n: ev.count });
        showTokens();
        break;
      case "search": collected.lookups.push({ query: ev.query }); status(`Searching: ${ev.query}`); renderNotes(); break;
      case "fetch": collected.lookups.push({ url: ev.url }); status(`Reading ${ev.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}…`); renderNotes(); break;
      case "progress":
        status(`Writing day ${ev.days} of ${o.expectedDays}…`);
        el("gen-bar").style.width = `${Math.min(100, (ev.days / o.expectedDays) * 100)}%`;
        break;
    }
  }

  return { onEvent, collected, stop: () => clearInterval(timer) };
}
