// Google Gemini in Settings → AI models: the key, what's known about its tier and today's requests per model (against
// the limits Google named), a step-by-step guide to a free key, and what to know before using a free one. Also the
// usage line under the Model menu while a Gemini model is picked.
import type { CloudProvider, GeminiStatus, KeyStatus } from "../../../shared/types";
import { $$, api, esc, toast } from "../core/dom";
import { ext, icon } from "../core/icons";
import { keyFieldHtml, wireKeyFields } from "./key-field";
import { openConnect } from "./connect-wizard";

const STUDIO = "https://aistudio.google.com/";
const STUDIO_KEYS = "https://aistudio.google.com/apikey";
const STUDIO_USAGE = "https://aistudio.google.com/usage?tab=rate-limit";
const link = (url: string, text: string) => `<a href="${url}" target="_blank" rel="noopener">${text}${ext()}</a>`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

let status: GeminiStatus | null = null, checking = false, guideOpen: boolean | null = null;

/** Gemini's status from the server (the first time for a key, the server checks its tier: a second or two). */
export async function loadGemini(): Promise<GeminiStatus | null> {
  status = await api<GeminiStatus>("/api/gemini").catch(() => null);
  return status;
}

const GUIDE = `<ol class="set-steps sync-guide">
  <li><b>Open Google AI Studio</b> and sign in with your Google account. The first time, accept the terms. It's free and needs no payment details.<br>${link(STUDIO, "Google AI Studio")}</li>
  <li><b>Go to the API keys:</b> <i>Get API key</i> (in the menu on the left, or at the bottom of it on small screens).<br>${link(STUDIO_KEYS, "API keys")}</li>
  <li><b>Press <i>Create API key</i>.</b> Pick one of your Google Cloud projects, or let AI Studio make one for you. Limits count per project, so every key in a project shares them.</li>
  <li><b>Copy the key</b> (the copy button next to it) and <b>paste it above</b>, then press <i>Save</i>. The planner checks right away whether it's on the free tier.</li>
  <li><b>Pick a Gemini model</b> in the Model menu under Planning. On the free tier, pick a <b>Flash</b> model: Pro models need billing.</li>
  <li><b>Optional, more requests and Pro models:</b> in AI Studio, press <i>Set up billing</i> next to the key's project. The same key then pays per use, with much higher limits, and Google no longer uses your prompts to improve its products. The planner notices at the next <i>Check again</i>.</li>
  <li><b>Optional, exact limits:</b> once the key is saved, an <b>Exact limits</b> card appears on this page. <i>Turn on</i> walks you through connecting Google, so every model's daily and per-minute limits show before you reach them, and no test requests are spent.</li>
</ol>
<p class="hint">Keep the key to yourself: anyone with it uses your quota (and, with billing, your money). It's kept on this computer only. In some countries Google offers the API only with billing set up; the tier check below says so.</p>`;

const WARNING = `<div class="gm-warn" role="note">
  <b>${icon("warn")} Before you use a free key</b>
  <ul>
    <li><b>Model access and rate limits.</b> The free tier restricts usage to specific models like the Flash series and enforces daily request caps (such as 250 requests per day depending on the specific model and authorization method). Pro-class models generally require a paid billing setup.</li>
    <li><b>Data privacy.</b> When using the free tier, Google may use your prompts and generated responses to improve its products. Avoid sending sensitive or confidential data through a free key.</li>
  </ul>
  <p class="hint">A plan sends your stays, dates, places, wishes and notes; the trip chat sends the trip and your messages (and pictures you add).</p>
</div>`;

const tierChip = (s: GeminiStatus) => checking ? `<span class="fit"><span class="sx-spin small"></span> Checking…</span>`
  : s.tier === "free" ? `<span class="fit warn">Free tier</span>`
  : s.tier === "paid" ? `<span class="fit ok">${icon("check")} Billing on</span>`
  : s.tier === "blocked" ? `<span class="fit warn">${icon("warn")} Needs billing here</span>`
  : `<span class="fit off">Tier not known</span>`;

/** One model's requests today, against its daily limit where Google named one. */
function useRow(m: GeminiStatus["models"][number], s: GeminiStatus) {
  const limited = s.limited?.model === m.model;
  const unlimited = m.perDay === -1, capped = m.perDay != null && m.perDay > 0;
  const of = capped ? ` of ${m.perDay}` : "";
  const pct = capped ? Math.min(100, (m.requests / m.perDay!) * 100) : 0;
  const per = (n: number | undefined, unit: string) => (n == null ? "" : n === -1 ? `unlimited a ${unit}` : `${n} a ${unit}`);
  const limits = [per(m.perDay, "day"), per(m.perMinute, "minute")].filter(Boolean).join(", ");
  return `<li class="gm-use${limited ? " full" : ""}">
    <code>${esc(m.model)}</code>
    <span>${m.requests}${of} request${capped || m.requests !== 1 ? "s" : ""}${unlimited ? " (unlimited)" : ""}${m.tokens ? ` · ${m.tokens.toLocaleString()} tokens` : ""}</span>
    ${capped ? `<span class="gm-bar" title="${esc(limits)}"><i style="width:${pct}%"></i></span>` : `<span class="hint">${limits ? `limit ${limits}` : "limit not named yet"}</span>`}
  </li>`;
}

/** Which of the catalog's models the key can run, from the test requests; the others folded away with the reason. */
function accessHtml(s: GeminiStatus) {
  if (!s.access.length) return "";
  const ok = s.access.filter((a) => a.state === "ok"), maybe = s.access.filter((a) => a.state === "unknown");
  const not = s.access.filter((a) => a.state === "billing" || a.state === "gone");
  const why = { billing: "needs billing", gone: "retired, or not offered to this key", unknown: "", ok: "" };
  return `<div class="set-row"><div><b>Models this key can run</b> <span class="fit ${ok.length ? "ok" : "warn"}">${ok.length} of ${s.access.length}</span>
      <div class="hint">Google's catalog lists every model, also ones a key can't use, so each was sent one test request. Only the ones that answered are in the Model menu.${maybe.length ? ` ${maybe.length} didn't answer (Google may have been busy): <i>Check again</i> tries them again.` : ""}</div>
      ${ok.length ? `<div class="gm-chips">${ok.map((a) => `<code title="${esc(a.note)}">${esc(a.model)}</code>`).join("")}</div>` : ""}
      ${maybe.length ? `<div class="gm-chips maybe">${maybe.map((a) => `<code title="${esc(a.note)}">${esc(a.model)} · no answer</code>`).join("")}</div>` : ""}
      ${not.length ? `<details class="gm-not"><summary>${not.length} more listed, but not usable with this key</summary>
        <ul>${not.map((a) => `<li><code>${esc(a.model)}</code> <span class="hint" title="${esc(a.note)}">${why[a.state]}</span></li>`).join("")}</ul></details>` : ""}
    </div></div>`;
}

/** Exact limits: off (with the way to turn it on), or on, with the project they're read from. */
function exactHtml(s: GeminiStatus) {
  const on = !!s.exact || !!s.exactError;
  return `<div class="set-row"><div><b>Your project's limits</b> ${on ? (s.exact ? `<span class="fit ok">${icon("check")} On</span>` : `<span class="fit warn">Not working</span>`) : `<span class="fit off">Off</span>`}
      <div class="hint">${s.exact ? `Every model's limits are read from your Google Cloud project <code>${esc(s.exact.project)}</code>, and no test requests are spent.`
        : "Optional. Reads every model's limits from your Google Cloud project, so you see them before reaching them and no test requests are spent. Needs your Google account."}</div>
      ${s.exactError ? `<div class="error-text">${icon("warn")} ${esc(s.exactError)}</div>` : ""}
      ${on ? `<details class="acc-manage"><summary>Key in a different project?</summary><div class="set-inline"><input id="gmProject" type="text" placeholder="Project ID or number" autocomplete="off" spellcheck="false" value="${esc(s.exact?.project || "")}"><button type="button" class="btn" data-gm-project>Save</button></div></details>` : ""}</div>
    <span class="set-inline">${!s.exact ? `<button type="button" class="btn solid" data-gm-exact>${!on ? "Turn on" : /sign in|connect google/i.test(s.exactError) ? "Connect Google" : "Show the steps"}</button>` : ""}${on ? `<button type="button" class="btn" data-gm-off>Turn off</button>` : ""}</span></div>`;
}

function statusHtml(s: GeminiStatus | null) {
  if (!s) return `<p class="hint"><span class="sx-spin small"></span> Trying the models with this key (a few seconds the first time)…</p>`;
  const used = s.models.filter((m) => m.requests || m.perDay != null);
  return `<div class="gm-status">
    <div class="set-row"><div><b>Tier</b> ${tierChip(s)}
        <div class="hint">${esc(s.tierNote || "Not checked yet.")}</div>
        <div class="hint">Google has no way to ask a key's tier, so the planner checks in two steps: the model catalog (which lists every model, whether or not the key may run them), then a test request ("hi", one token of answer) to each of its text models. A free-tier quota of 0 or "needs billing" on some means the free tier; every model answering means billing is on. On a free key each model that answers uses one of its requests for the day; with billing it costs a tiny fraction of a cent.</div></div>
      <button type="button" class="btn" data-gm-check ${checking ? "disabled" : ""}>${icon("refresh")} Check again</button></div>
    ${accessHtml(s)}
    ${s.limited ? `<p class="gm-limited">${icon("warn")} ${s.limited.perDay
      ? `Today's requests with <code>${esc(s.limited.model)}</code> are used up${s.limited.limit != null ? ` (${s.limited.limit} a day)` : ""}. They come back at ${clock(s.limited.until)}; until then, pick another Gemini model or another kind of model.`
      : `<code>${esc(s.limited.model)}</code> is at its per-minute limit for a moment.`}</p>` : ""}
    <div class="set-row"><div><b>Today</b> <span class="hint">Resets at ${clock(s.resetAt)} (midnight Pacific time)</span>
      ${used.length ? `<ul class="gm-uses">${used.map((m) => useRow(m, s)).join("")}</ul>` : `<div class="hint">No requests yet today.</div>`}
      <div class="hint">Requests counted by this planner: a plan is one request (plus one per fix round), a chat answer one or more. Other apps using the same Google Cloud project count toward the same limits.
        ${s.exact ? "" : `Google names a model's limit when it's reached; until then, AI Studio shows them: ${link(STUDIO_USAGE, "Usage and limits")}.`}</div></div></div>
  </div>`;
}

/**
 * The Gemini card in `root`: key, tier and usage, guide, warning. onKeyChange runs when the key is saved or removed,
 * with every provider's key status.
 */
export function mountGemini(root: HTMLElement, key: KeyStatus | undefined, onKeyChange: (keys: Record<CloudProvider, KeyStatus>) => void) {
  const draw = () => {
    const open = guideOpen ?? !key?.set;
    root.innerHTML = `
      ${WARNING}
      <div class="set-card kf-card">
        <div class="kf-list">${keyFieldHtml({ id: "gemini", name: "Gemini API key", status: key, env: "GEMINI_API_KEY", url: STUDIO_KEYS })}</div>
        <details class="sync-guide-box" id="gmGuide"${open ? " open" : ""}><summary>${key?.set ? "How to get a Gemini key" : "Step-by-step: get a free Gemini key (about 2 minutes)"}</summary>${GUIDE}</details>
      </div>
      ${key?.set ? `<div class="set-card">${statusHtml(status)}</div>
      ${status ? `<div class="set-card"><b class="card-title">${icon("sliders")} Exact limits <span class="hint">optional</span></b>${exactHtml(status)}</div>` : ""}
      <p class="hint">Pick <b>Gemini Auto</b> in a model menu to go on with the next Gemini model when one reaches its limit; a model you pick yourself is stayed on. Where the free tier doesn't include Google Search, plans research through the planner's own search first (<button type="button" class="link-btn" data-gm-search>Search &amp; places</button>), on a Flash Lite model for its larger daily limit.</p>
      ` : ""}`;
    wireKeyFields(root, async (_id, k) => {
      const now = await api<Record<CloudProvider, KeyStatus>>("/api/keys/gemini", { method: "PUT", body: JSON.stringify({ key: k }) });
      key = now.gemini; status = null; guideOpen = null;
      draw();
      onKeyChange(now);
      if (key?.set) { checking = true; draw(); await loadGemini(); checking = false; draw(); onKeyChange(now); }
    }, { gemini: "Gemini" });
    root.querySelector<HTMLButtonElement>("[data-gm-search]")?.addEventListener("click", () => { import("./settings").then((m) => m.openSettings("search")); });
    // Exact limits: turning them on (connecting Google where needed), off, or reading another project.
    const recheck = async () => {
      checking = true; draw();
      status = await api<GeminiStatus>("/api/gemini/check", { method: "POST" }).catch(() => status);
      checking = false; if (root.isConnected) draw();
      import("../generate/models").then((m) => m.refreshModels());
    };
    const use = async (google: object) => { await api("/api/settings", { method: "POST", body: JSON.stringify({ google }) }); await recheck(); };
    root.querySelector<HTMLButtonElement>("[data-gm-exact]")?.addEventListener("click", () => { openConnect("quotas", recheck, status?.exactError && !/sign in|connect google/i.test(status.exactError) ? "apis" : ""); });
    root.querySelector<HTMLButtonElement>("[data-gm-off]")?.addEventListener("click", () => use({ quotas: false }));
    root.querySelector<HTMLButtonElement>("[data-gm-project]")?.addEventListener("click", () => use({ project: root.querySelector<HTMLInputElement>("#gmProject")!.value.trim() }));
    root.querySelector<HTMLDetailsElement>("#gmGuide")?.addEventListener("toggle", (e) => { guideOpen = (e.target as HTMLDetailsElement).open; });
    root.querySelector<HTMLButtonElement>("[data-gm-check]")?.addEventListener("click", async () => {
      checking = true; draw();
      try {
        status = await api<GeminiStatus>("/api/gemini/check", { method: "POST" });
        toast(status.tier === "free" ? "It's a free-tier key" : status.tier === "paid" ? "Billing is on for this key" : status.tier === "blocked" ? "This key needs billing where you are" : "Couldn't tell the tier");
      }
      catch (e) { toast((e as Error).message); }
      checking = false; draw();
      // The Model menu offers only the models that answered.
      import("../generate/models").then((m) => m.refreshModels());
    });
  };
  draw();
  // Fresh counts each time it's shown (the last ones show meanwhile).
  if (key?.set) loadGemini().then(() => { if (root.isConnected) draw(); });
}

/** The line under the Model menu for a Gemini model: tier, today's requests with it, its limit and the reset. */
export function quotaLine(s: GeminiStatus | null, model: string) {
  if (!s?.set) return "";
  if (model === "auto") {
    const total = s.models.reduce((n, x) => n + x.requests, 0);
    return `<span class="gm-q">${icon("sparkles")} <b>Auto:</b> picks a model with requests left and moves on when one runs out · ${total} request${total === 1 ? "" : "s"} today · resets ${clock(s.resetAt)}</span>`;
  }
  const m = s.models.find((x) => x.model === model);
  const n = m?.requests || 0;
  if (s.tier === "blocked") return `<span class="gm-q full">${icon("warn")} <b>Needs billing:</b> Google doesn't offer the free tier where you are. Set up billing in Google AI Studio to use this key.</span>`;
  const tier = s.tier === "free" ? "Free tier" : s.tier === "paid" ? "Billing on" : "Gemini";
  if (s.limited?.model === model && s.limited.perDay) {
    return `<span class="gm-q full">${icon("warn")} <b>${tier}:</b> today's requests with this model are used up${s.limited.limit != null ? ` (${s.limited.limit} a day)` : ""}. Back at ${clock(s.limited.until)}; pick another Gemini model meanwhile.</span>`;
  }
  // A daily cap (from the project's quotas, or named by Google when it was reached); -1: unlimited.
  const cap = m?.perDay != null && m.perDay > 0 ? m.perDay : 0;
  const bar = cap ? `<span class="gm-bar"><i style="width:${Math.min(100, (n / cap) * 100)}%"></i></span>` : "";
  const limit = cap ? ` of ${cap}` : m?.perDay === -1 ? " (unlimited)" : "";
  const more = s.tier === "free" && m?.perDay == null ? ` · <a href="${STUDIO_USAGE}" target="_blank" rel="noopener">limits in AI Studio${ext()}</a>` : "";
  return `<span class="gm-q${cap && n / cap >= 0.8 ? " near" : ""}">${icon("sparkles")} <b>${tier}:</b> ${n}${limit} request${n === 1 && !cap ? "" : "s"} today with this model ${bar}· resets ${clock(s.resetAt)}${more}</span>`;
}

/** Shows or hides the usage lines wherever they are (after a request, the counts have changed). */
export function setQuotaLines(sel: string, model: string | null) {
  for (const el of $$<HTMLElement>(sel)) {
    if (!model) { el.hidden = true; el.innerHTML = ""; continue; }
    el.innerHTML = quotaLine(status, model);
    el.hidden = !el.innerHTML;
  }
}
