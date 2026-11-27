// Google Gemini through the Gemini API (generativelanguage.googleapis.com) with a key from Google AI Studio. A key is
// free to make: without billing on its Google Cloud project it gets the free tier (only some models, a few requests a
// minute and a day per model); with billing it pays per use. Plans search with Google Search (grounding) and answer
// with the itinerary as JSON, constrained to the schema where the model allows it next to the search tool.
//
// Google has no API that tells a key's tier or how much of its quota is left (AI Studio shows it). So:
// - the tier is found by asking a Pro model one tiny question, which free keys aren't allowed to use: a quota error
//   whose quota id ends in "FreeTier" means free, an answer means billing is on;
// - the planner counts its own requests per model per quota day (midnight to midnight Pacific time, as Google's are);
// - the limits come from Google's own quota errors (429 with a QuotaFailure naming the quota and its value). A 429 that
//   names none (e.g. a bare "Resource has been exhausted") is passed on in Google's words, not read as a limit.
import fs from "node:fs";
import path from "node:path";
import type { CloudModel, GeminiAccess, GeminiModelUse, GeminiStatus, RunResult, UsageNotice } from "../../shared/types";
import { ROOT, errMsg } from "../config";
import { getKey } from "../keys";
import { tune } from "../settings";
import { lines } from "../util/http";
import { localOutput } from "./local-output";
import { normalizeItinerary, parseJsonLoose } from "./output";
import { buildPrompt } from "./prompt";
import { LOCAL_SCHEMA } from "./schema";
import type { OnEvent, Runner, Trip } from "./types";
import type { Place } from "../../shared/types";
import { localResearch } from "../research/research";
import { type GeminiQuotas, type Limit, geminiQuotas, limitFor } from "./gemini-quotas";

// GEMINI_BASE_URL points elsewhere, e.g. a proxy (or a mock server in tests).
export const GEMINI_BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const USAGE_FILE = path.join(ROOT, "gemini-usage.json");
const STUDIO_USAGE = "https://aistudio.google.com/usage?tab=rate-limit";

/** Most output tokens each model allows, from the models list. */
const maxOutput = new Map<string, number>();

// ---- Models ----

// The list has embeddings, speech, images, live audio… Keep the text models that can plan.
const SKIP = /embedding|tts|image|audio|live|aqa|learnlm|robotics|computer-use|native|veo|imagen|banana|customtools|gemma|decision|transcribe|translate|omni|genie|lyria|antigravity|deep-research|nano/;
/** The menu's "Gemini Auto": the model is picked, and switched when one reaches a limit, by itself. */
export const AUTO = "auto";
/** "api|gemini|<model>" → the model (cloud-models.ts lists these, so it isn't imported from there). */
const modelOf = (id: string) => id.split("|").slice(2).join("|");
const version = (id: string) => Number(id.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);

export async function geminiModels(key: string): Promise<CloudModel[]> {
  const out: { id: string; name: string }[] = [];
  let page = "";
  do {
    const res = await fetch(`${GEMINI_BASE}/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, {
      headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(readError(res.status, await res.text()).message);
    const data: any = await res.json();
    for (const m of data.models || []) {
      const id = String(m.name || "").replace(/^models\//, "");
      if (!id.startsWith("gemini-") || SKIP.test(id) || !(m.supportedGenerationMethods || []).includes("generateContent")) continue;
      if (m.outputTokenLimit) maxOutput.set(id, m.outputTokenLimit);
      out.push({ id, name: m.displayName || id });
    }
    page = data.nextPageToken || "";
  } while (page);
  // Newest first; a stable model before its previews; "-latest" aliases last.
  out.sort((a, b) => version(b.id) - version(a.id) || Number(/preview|exp/.test(a.id)) - Number(/preview|exp/.test(b.id)) || a.id.localeCompare(b.id));
  return out.slice(0, 40).map((m) => ({ id: `api|gemini|${m.id}`, name: m.name, provider: "gemini" }));
}

/** A test request Google was too busy for (a timeout or a server error) says nothing against the model. */
const busy = (a: { state: GeminiAccess["state"]; note: string }) => a.state === "unknown" && /^(Didn't answer in time|5\d\d:)/.test(a.note);

/**
 * The catalog lists every public model, also ones this key can't run (none on the free tier, or retired for new
 * users). The models that answered the test request (checkTier) are offered, and those Google was too busy to answer
 * it for; if the models haven't been tried for this key yet, they're tried first.
 */
export async function usableGemini(models: CloudModel[]): Promise<CloudModel[]> {
  if (!readUsage().access) await checkTier().catch(() => {});
  const access = readUsage().access || {};
  return models.filter((m) => { const a = access[modelOf(m.id)]; return !!a && (a.state === "ok" || busy(a)); });
}

// ---- Errors and quotas ----

/** grounding: the quota is Google Search's (search grounding), not the model's. named: Google said which limit it is
 *  (a quota, its value or "per minute / day"); a 429 can also come without any of that, and then only `said` is known. */
interface QuotaHit { perDay: boolean; limit?: number; model?: string; freeTier: boolean; retrySec?: number; grounding: boolean; named: boolean; said: string }
/** keyProblem: the key itself was refused; region: the free tier isn't offered where you are (billing needed); billing:
 *  the model needs a paid (billing) setup. Region and billing come as 400 INVALID_ARGUMENT / FAILED_PRECONDITION or
 *  403 PERMISSION_DENIED, so a 403 alone doesn't mean a bad key. */
interface GeminiError { message: string; status: number; quota?: QuotaHit; keyProblem: boolean; region: boolean; billing: boolean }

/** Google's error body, read into what went wrong; a quota error (429) says which quota, its value and the wait. */
export function readError(status: number, body: string): GeminiError {
  let err: any = {};
  // The OpenAI-compatible endpoint (research) sends the same error inside a list.
  try { const j = JSON.parse(body); err = (Array.isArray(j) ? j[0] : j)?.error || {}; } catch { /* not JSON */ }
  const message = String(err.message || body || `HTTP ${status}`).slice(0, 500);
  const details: any[] = Array.isArray(err.details) ? err.details : [];
  const all = `${message} ${JSON.stringify(details)}`;
  const region = /location is not supported|not (available|supported) in your (country|region)|free tier is not available/i.test(message);
  const billing = !region && /billing|paid tier|paid plan|requires? (a )?pa(id|yment)|upgrade your plan|not available on the free tier|free tier (does not|doesn't) (include|support)/i.test(message);
  const keyProblem = !region && !billing && (status === 401 || /API key not valid|API_KEY_INVALID|API key expired|API_KEY_SERVICE_BLOCKED|SERVICE_DISABLED|has not been used in project|unregistered callers/i.test(all)
    || (status === 403 && /API key|permission denied/i.test(message)));
  let quota: QuotaHit | undefined;
  if (status === 429) {
    const violations: any[] = details.filter((d) => String(d["@type"] || "").endsWith("QuotaFailure")).flatMap((d) => d.violations || []);
    const retry = details.find((d) => String(d["@type"] || "").endsWith("RetryInfo"))?.retryDelay;
    // The daily quota is the one that matters when both are named.
    const v = violations.find((x) => /PerDay/i.test(x.quotaId || "")) || violations[0];
    const limit = Number(v?.quotaValue ?? message.match(/limit: (\d+)/)?.[1]);
    quota = {
      perDay: v ? /PerDay/i.test(v.quotaId || "") : /per ?day|daily/i.test(message),
      limit: Number.isFinite(limit) ? limit : undefined,
      model: v?.quotaDimensions?.model || message.match(/model: ([\w.-]+)/)?.[1],
      freeTier: violations.some((x) => /free_?tier/i.test(`${x.quotaId} ${x.quotaMetric}`)) || /free_tier/i.test(message),
      retrySec: parseFloat(retry || message.match(/retry in ([\d.]+)s/i)?.[1] || "") || undefined,
      grounding: violations.some((x) => /ground|search/i.test(`${x.quotaId} ${x.quotaMetric}`)) || /grounding|google search/i.test(message),
      named: violations.length > 0 || /per ?(minute|day)|daily|limit: \d+/i.test(message),
      said: message,
    };
    // The per-minute limit is learned too when Google names both.
    for (const x of violations) learnLimit(x.quotaDimensions?.model || quota.model, /PerDay/i.test(x.quotaId || ""), Number(x.quotaValue));
  }
  return { message, status, quota, keyProblem, region, billing };
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A quota error in words, with what to do about it. */
function quotaMessage(model: string, q: QuotaHit) {
  if (!q.named) {
    return `Google refused the request to ${model} (429) without naming a limit. It said: "${q.said}" `
      + `Try again later, or pick "Gemini Auto" or another model. Your usage: ${STUDIO_USAGE}`;
  }
  const tier = q.freeTier ? "Gemini's free tier" : "Your Gemini key";
  if (q.perDay) {
    if (q.limit === 0) return `${model} isn't included in Gemini's free tier. Pick a Flash model, or set up billing for the key's project in Google AI Studio.`;
    return `${tier} allows ${q.limit != null ? `${q.limit} requests a day` : "only so many requests a day"} with ${model}, and today's are used up. `
      + `They come back at ${clock(quotaDay().resetAt)} (midnight Pacific time). Until then, pick "Gemini Auto" (it moves on to a model that has requests left), another Gemini model (each has its own quota) or another kind of model`
      + `${q.freeTier ? ", or set up billing in Google AI Studio for much higher limits" : ""}. Your usage: ${STUDIO_USAGE}`;
  }
  return `${tier} allows ${q.limit != null ? `${q.limit} requests a minute` : "only so many requests a minute"} with ${model}.`
    + ` Wait ${q.retrySec ? `${Math.ceil(q.retrySec)} seconds` : "a minute"} and try again.`;
}

// ---- Usage, kept per quota day ----

interface Usage {
  /** The key's last characters: a different key starts over. */
  key: string;
  day: string;
  requests: Record<string, number>;
  tokens: Record<string, number>;
  limits: Record<string, { day?: number; minute?: number }>;
  tier?: { kind: GeminiStatus["tier"]; note: string; at: number };
  limited?: GeminiStatus["limited"];
  /** What each listed model answered to the test request (checkTier); none until the models were tried. */
  access?: Record<string, { state: GeminiAccess["state"]; note: string }>;
  /** Models whose daily limit was reached today (requests go on with another model). */
  exhausted?: string[];
  /** Models that may not use Google Search on this key's tier (they research through the planner instead). */
  noSearch?: Record<string, true>;
}

/** Google's quota day: the date in Pacific time, and when the next one starts. */
export function quotaDay(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const into = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, resetAt: now - into - (now % 1000) + 86_400_000 };
}

const keyTag = () => getKey("gemini").slice(-6);

function readUsage(): Usage {
  let u: Usage | null = null;
  try { u = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch { /* none yet */ }
  const { day } = quotaDay(), key = keyTag();
  if (!u || u.key !== key) u = { key, day, requests: {}, tokens: {}, limits: {} };
  if (u.day !== day) { u.day = day; u.requests = {}; u.tokens = {}; u.exhausted = []; }
  if (u.limited && u.limited.until <= Date.now()) u.limited = null;
  return u;
}
function writeUsage(u: Usage) {
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2)); } catch (e) { console.warn(`Could not save Gemini usage: ${errMsg(e)}`); }
}
function changeUsage(f: (u: Usage) => void) { const u = readUsage(); f(u); writeUsage(u); }

function learnLimit(model: string | undefined, perDay: boolean, value: number) {
  if (!model || !Number.isFinite(value)) return;
  changeUsage((u) => { const l = (u.limits[model] ||= {}); if (perDay) l.day = value; else l.minute = value; });
}
/** A successful request; it also settles a model whose test request got no answer. */
const countRequest = (model: string) => changeUsage((u) => {
  u.requests[model] = (u.requests[model] || 0) + 1;
  if (u.access?.[model]?.state === "unknown") u.access[model] = { state: "ok", note: "Answered a request." };
});
const countTokens = (model: string, n: number) => { if (n) changeUsage((u) => { u.tokens[model] = (u.tokens[model] || 0) + n; }); };

/** What's known about the key: tier, today's requests per model and the limits Google named. */
export async function geminiStatus(): Promise<GeminiStatus> {
  const key = getKey("gemini");
  // Not tried yet for this key (or only by the older single-model check): try the models now.
  if (key && !readUsage().access) await checkTier().catch(() => {});
  // Exact limits from the Google Cloud project, where set up: every usable model with its limits, not only the ones
  // used today. (null: none on this tier → 0; -1: unlimited.)
  const exact = await geminiQuotas();
  const q = exact.quotas;
  const u = readUsage(), { day, resetAt } = quotaDay();
  const usable = Object.entries(u.access || {}).filter(([, a]) => a.state === "ok").map(([m]) => m);
  const names = new Set([...Object.keys(u.requests), ...Object.keys(u.limits), ...(q ? usable : [])]);
  const limit = (list: Record<string, Limit> | undefined, model: string, learned?: number) => {
    const v = list ? limitFor(list, model) : undefined;
    return v === undefined ? learned : v === null ? 0 : v;
  };
  const models: GeminiModelUse[] = [...names].map((model) => ({
    model, requests: u.requests[model] || 0, tokens: u.tokens[model] || 0,
    perDay: limit(q?.perDay, model, u.limits[model]?.day), perMinute: limit(q?.perMinute, model, u.limits[model]?.minute),
  })).sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
  return {
    set: !!key, tier: u.tier?.kind || "unknown", tierNote: u.tier?.note || "", checkedAt: u.tier?.at || 0,
    day, resetAt, models, limited: u.limited || null,
    access: Object.entries(u.access || {}).map(([model, a]) => ({ model, ...a })),
    exact: q ? { project: q.project, billing: q.billing } : null, exactError: exact.error,
  };
}

/** The chat's warning for a Gemini model: today's requests used up, or most of its daily limit (from the project's
 *  quotas, or as Google named it). */
export async function geminiNotice(model: string): Promise<UsageNotice | null> {
  if (!getKey("gemini")) return null;
  if (model === AUTO) {
    return readUsage().access && !nextModel(new Set()) ? { level: "out", text: "Today's requests are used up on every Gemini model this key can run", resetsAt: quotaDay().resetAt, url: STUDIO_USAGE } : null;
  }
  const q = (await geminiQuotas()).quotas, u = readUsage(), { resetAt } = quotaDay();
  const exact = q ? limitFor(q.perDay, model) : undefined;
  const limit = exact === undefined ? u.limits[model]?.day : exact ?? 0;
  const used = u.requests[model] || 0;
  if (u.exhausted?.includes(model) || (limit && limit > 0 && used >= limit)) {
    return { level: "out", text: `Today's requests with ${model} are used up; pick Gemini Auto or another model`, resetsAt: resetAt, url: STUDIO_USAGE };
  }
  if (!limit || limit < 0 || used / limit < 0.8) return null;
  return { level: "warn", text: `You've used ${used} of today's ${limit} requests with ${model}`, resetsAt: resetAt, url: STUDIO_USAGE };
}

/** The tier's billing for a run: free while the key is on the free tier. */
export const geminiBilling = (): "free" | "api" => (readUsage().tier?.kind === "free" ? "free" : "api");

let checking: Promise<void> | null = null;

/** What one model answered to the test request, in words. */
interface Probe { model: string; state: GeminiAccess["state"]; note: string; freeTier?: boolean; paidQuota?: boolean; region?: string; key?: string }

/** "hi" with one token of answer to a model (once more without the limit if Google rejects only that). */
async function probeModel(key: string, model: string): Promise<Probe> {
  const send = (limitOutput: boolean) => fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST", signal: AbortSignal.timeout(45000), headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], ...(limitOutput ? { generationConfig: { maxOutputTokens: 1 } } : {}) }),
  });
  let res: Response, e: GeminiError | null;
  try {
    res = await send(true);
    e = res.ok ? null : readError(res.status, await res.text());
    if (e && res.status === 400 && !e.region && !e.billing && !e.keyProblem) {
      res = await send(false);
      e = res.ok ? null : readError(res.status, await res.text());
    }
    // Busy for a moment ("high demand"): once more, shortly after.
    if (e && res.status >= 500) {
      await sleep(2000);
      res = await send(true);
      e = res.ok ? null : readError(res.status, await res.text());
    }
  } catch (err) {
    return { model, state: "unknown", note: /abort|timeout/i.test(errMsg(err)) ? "Didn't answer in time (Google busy?). Check again tries it again." : `No answer: ${errMsg(err)}` };
  }
  if (!e) { countRequest(model); return { model, state: "ok", note: "Answered the test request." }; }
  const q = e.quota;
  if (q?.perDay && q.limit === 0) return { model, state: "billing", note: q.freeTier ? "None on the free tier (a quota of 0): needs billing." : "A quota of 0 for this key.", freeTier: q.freeTier };
  if (q && !q.named) return { model, state: "unknown", note: `Google refused the test request (429): ${q.said}` };
  if (q) return { model, state: "ok", note: `Usable, but at its ${q.perDay ? "daily" : "per-minute"} limit${q.limit != null ? ` of ${q.limit}` : ""} right now.`, freeTier: q.freeTier, paidQuota: !q.freeTier };
  if (e.region) return { model, state: "unknown", note: e.message, region: e.message };
  if (e.billing) return { model, state: "billing", note: `Needs a paid billing setup (Google: ${e.message})`, freeTier: true };
  if (e.keyProblem) return { model, state: "unknown", note: e.message, key: e.message };
  if (res.status === 404 || /no longer available|not found|is not supported for generateContent/i.test(e.message)) return { model, state: "gone", note: `Not offered to this key: ${e.message}` };
  return { model, state: "unknown", note: `${res.status}: ${e.message}` };
}

/**
 * Tells a free key from a paid one, and which models it can run, in two steps (the Gemini API keeps finding models
 * apart from billing):
 * 1. The catalog (models.list). It lists every public model whether or not this key may run it: also ones with a quota
 *    of 0 on the free tier, and ones retired for new users (404 "no longer available").
 * 2. A test request to each of its text models: "hi" with maxOutputTokens 1, read by its answer:
 *    - 200: usable. (On a free key this uses one of that model's requests for the day.)
 *    - 429 RESOURCE_EXHAUSTED with a quota of 0: none on this tier, needs billing; with another value: usable, at its
 *      per-minute or daily ceiling right now. The quota's name says whether it's a free-tier one.
 *    - 400 INVALID_ARGUMENT / FAILED_PRECONDITION or 403 PERMISSION_DENIED: the message says why: the model needs a
 *      paid billing setup, the free tier isn't offered in this region, or the key is refused.
 *    - 404: retired, or not offered to this key.
 * The tier follows: a free-tier quota or "needs billing" anywhere → free (the free tier always leaves some text models
 * at 0); the region refused → needs billing; every model that exists answering → billing is on.
 */
export function checkTier(): Promise<void> {
  return checking ||= (async () => {
    const key = getKey("gemini");
    if (!key) return;
    const set = (kind: GeminiStatus["tier"], note: string, access?: Usage["access"]) =>
      changeUsage((u) => { u.tier = { kind, note, at: Date.now() }; if (access) { u.access = access; u.noSearch = {}; } });
    // 1. The catalog.
    let ids: string[];
    try { ids = (await geminiModels(key)).map((m) => modelOf(m.id)); }
    catch (e) { return set("unknown", `Google didn't accept the key: ${errMsg(e)}`, {}); }
    if (!ids.length) return set("unknown", "Google's catalog has no Gemini text models for this key.", {});
    // With exact limits, no request is spent: countTokens spots retired models (404) and the
    // project's quota list the ones with none on its tier. Only models the list doesn't name get a test request.
    const { quotas } = await geminiQuotas(true);
    if (quotas) return set(...exactCheck(await exactProbes(key, ids, quotas), quotas));
    // 2. A test request to each, a few at a time.
    const probes: Probe[] = [];
    for (let i = 0; i < ids.length; i += 4) probes.push(...await Promise.all(ids.slice(i, i + 4).map((m) => probeModel(key, m))));
    const access = Object.fromEntries(probes.map((p) => [p.model, { state: p.state, note: p.note }]));
    for (const p of probes) if (p.state === "billing") learnLimit(p.model, true, 0);
    const ok = probes.filter((p) => p.state === "ok"), billing = probes.filter((p) => p.state === "billing");
    const names = (ps: Probe[]) => ps.map((p) => p.model).join(", ");
    const region = probes.find((p) => p.region), refused = probes.find((p) => p.key);
    if (region && !ok.length) return set("blocked", `Google says: ${region.region} The free tier isn't offered where you are: set up billing on the key's project in Google AI Studio to use the key.`, access);
    if (refused && !ok.length) return set("unknown", `Google refused the key: ${refused.key}`, access);
    if (probes.some((p) => p.freeTier)) {
      return set("free", `Free tier: ${ok.length} of ${probes.length} models answered (${names(ok) || "none"}). `
        + `${billing.length ? `${billing.length} need billing (${names(billing)}). ` : ""}Google named free-tier quotas.`, access);
    }
    if (ok.length && !billing.length) return set("paid", `Billing is on: every available model answered (${names(ok)}), Pro-class ones too, which the free tier doesn't include.`, access);
    if (ok.length) return set("unknown", `${ok.length} models answered (${names(ok)}); ${billing.length} have a quota of 0, but Google didn't say which tier.`, access);
    set("unknown", `No model answered: ${probes[0]?.note || "no answer"}`, access);
  })().finally(() => { checking = null; });
}

/** countTokens for "hi": generates nothing and spends none of the model's requests, but a retired model answers 404. */
async function countModel(key: string, model: string): Promise<{ gone: boolean; note: string }> {
  try {
    const res = await fetch(`${GEMINI_BASE}/models/${model}:countTokens`, {
      method: "POST", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    if (res.ok) return { gone: false, note: "" };
    const e = readError(res.status, await res.text());
    return res.status === 404 ? { gone: true, note: `Not offered to this key: ${e.message}` } : { gone: false, note: e.message };
  } catch (err) { return { gone: false, note: errMsg(err) }; }
}

/** Each model by the project's quota list and countTokens; models the list doesn't name get the usual test request. */
async function exactProbes(key: string, ids: string[], quotas: GeminiQuotas): Promise<Probe[]> {
  const one = async (model: string): Promise<Probe> => {
    const c = await countModel(key, model);
    if (c.gone) return { model, state: "gone", note: c.note };
    const day = limitFor(quotas.perDay, model);
    if (day === undefined) return probeModel(key, model);
    if (day === null || day === 0) return { model, state: "billing", note: `None on this tier (your project's quota${quotas.billing ? "" : ": needs billing"}).` };
    return { model, state: "ok", note: `${day === -1 ? "Unlimited requests" : `${day} requests`} a day (your project's quota).` };
  };
  const out: Probe[] = [];
  for (let i = 0; i < ids.length; i += 6) out.push(...await Promise.all(ids.slice(i, i + 6).map(one)));
  return out;
}

/** The tier and note from the exact check: billing on or off as Google's billing says (else by the quotas). */
function exactCheck(probes: Probe[], q: GeminiQuotas): [GeminiStatus["tier"], string, Usage["access"]] {
  const access = Object.fromEntries(probes.map((p) => [p.model, { state: p.state, note: p.note }]));
  const ok = probes.filter((p) => p.state === "ok").map((p) => p.model), none = probes.filter((p) => p.state === "billing").length;
  const kind: GeminiStatus["tier"] = q.billing === true ? "paid" : q.billing === false || none ? "free" : "unknown";
  const word = kind === "paid" ? "Billing is on" : kind === "free" ? "Free tier" : "Tier not known";
  return [kind, `${word}, from your Google Cloud project ${q.project} (exact, no requests spent): ${ok.length} of ${probes.length} models available (${ok.join(", ") || "none"})`
    + `${none ? `, ${none} with none on this tier` : ""}.`, access];
}

/** After a key is saved or removed: start over, and check the new key's tier. */
export function geminiKeyChanged() {
  writeUsage(readUsage());
  if (getKey("gemini")) checkTier().catch(() => {});
}

// ---- Requests ----

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason || new Error("Cancelled")); }, { once: true });
});

/** The wait before asking again after a 429 that waiting may clear (a per-minute limit, or one Google didn't name),
 *  and the status line for it; null once it has been waited for often enough. An unnamed one gets two tries. */
function retryWait(model: string, q: QuotaHit, waited: number, waits: number) {
  if (q.perDay || waited >= (q.named ? waits : 2)) return null;
  const s = Math.ceil(q.retrySec || (q.named ? 30 : 10 * (waited + 1)));
  if (s > 65) return null;
  return { s, text: q.named
    ? `Gemini's per-minute limit for ${model} is reached: waiting ${s} seconds`
    : `Google refused the request to ${model} ("${q.said.slice(0, 160)}"): trying again in ${s} seconds` };
}

/** The model can't answer now (its daily limit, its per-minute limit even after waiting, or it needs billing); another
 *  Gemini model the key can run may. `short` says so in a few words, for the switch's status line. */
class SwitchableError extends Error { constructor(message: string, public short: string) { super(message); } }
/** Google Search was refused for this model on this key (the free tier doesn't include it for Gemini 3 and newer:
 *  a search-grounding quota of 0, or a 429 naming no limit). */
class NoSearchError extends Error {}

/** The models the key can run, in the order to switch to: the ones the test requests found, newest first, the full
 *  models before the Lite ones, then the ones Google was too busy to answer for; not the ones already tried or used up
 *  today. */
function nextModel(tried: Set<string>): string | undefined {
  const u = readUsage(), out = new Set(u.exhausted || []);
  const left = Object.entries(u.access || {}).filter(([m]) => !tried.has(m) && !out.has(m));
  const ok = left.filter(([, a]) => a.state === "ok").map(([m]) => m);
  return [...ok.filter((m) => !/lite/.test(m)), ...ok.filter((m) => /lite/.test(m)), ...left.filter(([, a]) => busy(a)).map(([m]) => m)][0];
}
const noSearch = (model: string) => !!readUsage().noSearch?.[model];

/**
 * One request to one model, with bodies tried in order while Google rejects one as invalid (400: e.g. the schema next
 * to the search tool, or thinking on a model without it). A per-minute limit is waited out (`waits` times; onWait says
 * so), and a refusal without a named limit is tried again twice.
 * Successful requests are counted for today.
 */
async function requestModel(model: string, method: string, bodies: object[], signal: AbortSignal, searching: boolean, onWait?: (text: string) => void, onBody?: (i: number) => void, waits = 1) {
  const key = getKey("gemini");
  if (!key) throw new Error("No Google Gemini API key. Add one under Settings → AI models, or set GEMINI_API_KEY.");
  let waited = 0, refused = 0;
  for (let i = 0; i < bodies.length;) {
    onBody?.(i);
    const res = await fetch(`${GEMINI_BASE}/models/${model}:${method}`, {
      method: "POST", signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(bodies[i]),
    });
    if (res.ok) { countRequest(model); return res; }
    const e = readError(res.status, await res.text());
    if (e.keyProblem) throw new Error(`Google didn't accept the Gemini key: ${e.message}`);
    if (e.quota) {
      const q = e.quota;
      if (q.freeTier) changeUsage((u) => { if (u.tier?.kind !== "free") u.tier = { kind: "free", note: "Free tier: Google named a free-tier quota when a limit was reached.", at: Date.now() }; });
      // Searching, and the quota is named for search grounding, or a model that answers without the search tool gets a
      // quota of 0, or on the free tier the refusal names no limit (how Google answers there, also for models whose test
      // request got no answer): it's Google Search that isn't included, not the model. Without search it's asked again.
      const u = readUsage(), answers = u.access?.[model]?.state === "ok";
      if (searching && (q.grounding || (q.limit === 0 && answers) || (!q.named && u.tier?.kind === "free"))) throw new NoSearchError(e.message);
      if (q.perDay) changeUsage((u) => { u.limited = { model, perDay: true, limit: q.limit, until: quotaDay().resetAt }; u.exhausted = [...new Set([...(u.exhausted || []), model])]; });
      const wait = onWait && retryWait(model, q, q.named ? waited : refused, waits);
      if (wait) {
        if (q.named) waited++; else refused++;
        onWait(`${wait.text}, then going on…`);
        await sleep(wait.s * 1000 + 500, signal);
        continue;
      }
      throw new SwitchableError(quotaMessage(model, q), q.perDay
        ? q.limit === 0 ? `${model} isn't included in this key's tier.` : `${model} has used today's${q.limit != null ? ` ${q.limit}` : ""} requests.`
        : q.named ? `${model} is still at its per-minute limit.` : `Google keeps refusing requests to ${model}.`);
    }
    if (e.region) {
      changeUsage((u) => { u.tier = { kind: "blocked", note: `Google says: ${e.message} The free tier isn't offered where you are: set up billing to use the key.`, at: Date.now() }; });
      throw new Error(`Google: ${e.message} The free tier isn't offered where you are: set up billing on the key's project in Google AI Studio.`);
    }
    if (e.billing) {
      changeUsage((u) => { u.limits[model] = { ...u.limits[model], day: 0 }; if (u.tier?.kind !== "free") u.tier = { kind: "free", note: `Free tier: Google said ${model} needs a paid billing setup.`, at: Date.now() }; });
      throw new SwitchableError(`${model} needs a paid billing setup (Google: ${e.message}). Pick a Flash model, or set up billing for the key's project in Google AI Studio.`, `${model} needs billing.`);
    }
    if (res.status === 400 && i < bodies.length - 1) { i++; continue; }
    throw new Error(`Google Gemini: ${e.message}`);
  }
  throw new Error("Google Gemini rejected every form of the request.");
}

interface FetchOptions {
  model: string;
  method: string;
  /** The request's bodies for a model, with or without the Google Search tool. */
  bodies: (model: string, search: boolean) => object[];
  /** Whether to search with Google (where the key's tier allows it). */
  search: boolean;
  signal: AbortSignal;
  /** Waiting, switching models, or going on without search, in words. */
  onStatus?: (text: string) => void;
  onBody?: (model: string, i: number, search: boolean) => void;
  /** Google Search isn't included for this model on the key's tier: get ready to ask without it (planning researches
   *  through the planner's own web search here). */
  onNoSearch?: (model: string) => Promise<void>;
}

/**
 * A request that keeps going where it can: when the model's limit is reached (or it needs billing), it goes on with the
 * next Gemini model the key can run (each has its own quota); when Google Search isn't included for a model on this
 * tier, that model answers without it (remembered, so it isn't asked for again). Says which model answered.
 */
async function geminiFetch(o: FetchOptions): Promise<{ res: Response; model: string; search: boolean; switched: string[] }> {
  const tried = new Set<string>(), switched: string[] = [];
  const auto = o.model === AUTO;
  if (auto && !readUsage().access) await checkTier().catch(() => {});
  const first = auto ? nextModel(tried) : o.model;
  if (!first) throw new Error(`No Gemini model this key can run has requests left today. They come back at ${clock(quotaDay().resetAt)}. Settings → AI models → Google Gemini shows each model.`);
  let model = first, search = o.search && !noSearch(model);
  for (;;) {
    tried.add(model);
    if (o.search && !search) await o.onNoSearch?.(model);
    try {
      // A picked model is stayed on, so a per-minute limit is waited out a few times; Auto moves on after one wait.
      const res = await requestModel(model, o.method, o.bodies(model, search), o.signal, search, o.onStatus, (i) => o.onBody?.(model, i, search), auto ? 1 : 4);
      return { res, model, search, switched };
    } catch (e) {
      if (e instanceof NoSearchError) {
        changeUsage((u) => { (u.noSearch ||= {})[model] = true; });
        search = false;
        o.onStatus?.(`Google Search isn't included for ${model} on this key's tier: researching with the planner's own web search instead…`);
        continue;
      }
      if (!(e instanceof SwitchableError) || !auto) throw e;
      const next = nextModel(tried);
      if (!next) throw new Error(`${e.message}${tried.size > 1 ? `\n\nThe other Gemini models this key can run (${[...tried].slice(0, -1).join(", ")}) couldn't answer either.` : "\n\nNo other Gemini model this key can run has requests left."}`);
      o.onStatus?.(`${e.short} Going on with ${next}…`);
      switched.push(`${model} → ${next}`);
      model = next;
      search = o.search && !noSearch(model);
    }
  }
}

/** Server-sent events from streamGenerateContent, one JSON chunk each. */
async function* chunks(res: Response) {
  for await (const line of lines(res.body as any)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try { yield JSON.parse(data); } catch { /* partial line */ }
  }
}

const STOP_ERRORS: Record<string, string> = {
  MAX_TOKENS: "ran out of output tokens before finishing", SAFETY: "stopped by Google's safety filter",
  RECITATION: "stopped because the answer quoted a source too closely", PROHIBITED_CONTENT: "stopped by Google's content filter",
  BLOCKLIST: "stopped by Google's content filter", SPII: "stopped because the answer held personal data",
};

// ---- Research through the planner (when Google Search isn't included) ----

/** The model that researches: on the free tier a Flash Lite model the key can run, also when another model is picked
 *  to plan (research is a request per search, and Lite models have many more a day); otherwise, or without one, the
 *  planning model. */
function researchModel(planModel: string) {
  const u = readUsage();
  if (u.tier?.kind !== "free" || /lite/.test(planModel)) return planModel;
  const out = new Set(u.exhausted || []);
  return Object.entries(u.access || {}).find(([m, a]) => a.state === "ok" && /lite/.test(m) && !out.has(m))?.[0] || planModel;
}

/**
 * Researches the trip the way local models do: the planner runs the model's web_search / fetch_page calls (Brave,
 * SearXNG, DuckDuckGo, Wikipedia, as set in Settings → Search & places), through Gemini's OpenAI-compatible endpoint, which
 * takes tools. Requests are counted; a per-minute limit is waited out up to five times (research asks many times in a
 * row), an unnamed refusal tried again twice. `why`: said in the prompt's note about the model.
 */
async function plannerResearch(trip: Trip, places: Place[], onEvent: OnEvent, abort: AbortSignal, output: ReturnType<typeof localOutput>, model: string, why: string) {
  const key = getKey("gemini");
  if (!key) throw new Error("No Google Gemini API key");
  const send = async (body: object, signal: AbortSignal) => {
    for (let waited = 0; ;) {
      const res = await fetch(`${GEMINI_BASE}/openai/chat/completions`, {
        method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
      });
      if (res.ok) { countRequest(model); return res; }
      const e = readError(res.status, await res.text());
      const wait = e.quota && retryWait(model, e.quota, waited, 5);
      if (wait) {
        waited++;
        onEvent({ type: "status", text: `${wait.text}, then researching on…` });
        await sleep(wait.s * 1000 + 500, signal);
        continue;
      }
      if (e.quota?.perDay) changeUsage((u) => { u.exhausted = [...new Set([...(u.exhausted || []), model])]; });
      throw new Error(e.quota ? quotaMessage(model, e.quota) : `Google Gemini: ${e.message}`);
    }
  };
  let searches = 0;
  const count: OnEvent = (ev) => { if (ev.type === "search") searches++; onEvent(ev); };
  const found = await localResearch({
    kind: "openai", base: GEMINI_BASE, model, trip, places, onEvent: count, abort, onThinking: output.onThinking, tick: output.tick,
    endpoint: { send }, server: `Google Gemini (OpenAI-compatible endpoint; ${why})`,
  });
  return { ...found, model, searches };
}

/** Research with the Gemini model chosen for it ("Gemini Auto": picked like the one that researches for a plan). */
export async function geminiResearch(id: string, trip: Trip, places: Place[], onEvent: OnEvent, abort: AbortSignal, output: ReturnType<typeof localOutput>) {
  let model = modelOf(id);
  if (model === AUTO) {
    if (!readUsage().access) await checkTier().catch(() => {});
    const first = nextModel(new Set());
    if (!first) throw new Error("No Gemini model this key can run has requests left today");
    model = researchModel(first);
  }
  return plannerResearch(trip, places, onEvent, abort, output, model, "the research model");
}

// ---- Planning ----

export const runGemini: Runner = async (trip, places, onEvent, abort): Promise<RunResult> => {
  const t0 = Date.now();
  const output = localOutput(onEvent);
  const queries = new Set<string>();
  let outTokens = 0, total = 0, finish = "", blocked = "";

  // Without Google Search: the planner's own research, once, before the plan (its findings go into the prompt).
  let researched: Awaited<ReturnType<typeof plannerResearch>> | null = null, researchTried = false, researchFailed = "";
  const onNoSearch = async (model: string) => {
    if (researchTried || !trip.research) return;
    researchTried = true;
    try {
      const by = researchModel(model);
      researched = await plannerResearch(trip, places, onEvent, abort, output, by, by === model ? "the planning model" : "a Flash Lite model, for its larger daily limit");
      if (researched.notes) onEvent({ type: "notes", text: `**Research findings**\n\n${researched.notes}` });
    } catch (e) {
      if (abort.aborted) throw e;
      researchFailed = errMsg(e).replace(/^NO_TOOLS$/, "the model couldn't use the search tools");
      onEvent({ type: "status", text: `Research didn't work (${researchFailed.slice(0, 160)}), so it plans without it…` });
    }
    output.restart();
  };

  // The prompt tells the model it can search only when it can (otherwise it gets the research findings);
  // enforced schema first, then the schema in the prompt.
  const prompt = (search: boolean, schemaInPrompt: boolean) => buildPrompt(search ? trip : { ...trip, researchNotes: researched?.notes ?? trip.researchNotes }, places, { notes: "json", webTools: search, schema: schemaInPrompt });
  const text = (p: string) => ({ contents: [{ role: "user", parts: [{ text: p }] }] });
  const bodies = (model: string, search: boolean) => {
    const tools = search ? { tools: [{ google_search: {} }] } : {};
    const gen = { maxOutputTokens: maxOutput.get(model) || 65536 };
    return [
      { ...text(prompt(search, false)), ...tools, generationConfig: { ...gen, responseMimeType: "application/json", responseJsonSchema: LOCAL_SCHEMA, thinkingConfig: { includeThoughts: true } } },
      { ...text(prompt(search, true)), ...tools, generationConfig: { ...gen, thinkingConfig: { includeThoughts: true } } },
      { ...text(prompt(search, true)), ...tools, generationConfig: gen },
    ];
  };
  const billing = geminiBilling();
  let shown = "";
  const got = await geminiFetch({
    model: modelOf(trip.model), method: "streamGenerateContent?alt=sse", bodies, search: !!trip.research, signal: abort,
    onStatus: (status) => onEvent({ type: "status", text: status }),
    onNoSearch,
    onBody: (model, i, search) => {
      const tag = `${model}|${search}|${i ? 1 : 0}`;
      if (tag === shown) return;
      shown = tag;
      onEvent({
        type: "prompt", label: i ? "Prompt (retry without enforced schema)" : "Prompt",
        info: `Sent to Google Gemini · model: ${model}${search ? " · tool: Google Search" : trip.research ? ` · without Google Search (not included on this key's tier)${researched?.notes ? ", with the planner's research findings" : ""}` : ""} · `
          + `${i ? "schema in the prompt" : "answer constrained to the itinerary JSON schema"} · ${billing === "free" ? "on the key's free tier" : "billed to your API key"}.`,
        text: prompt(search, !!i),
      });
    },
  });
  const model = got.model;

  for await (const c of chunks(got.res)) {
    if (c.promptFeedback?.blockReason) blocked = c.promptFeedback.blockReason;
    const cand = c.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (typeof part.text !== "string" || !part.text) continue;
      output.tick();
      if (part.thought) output.onThinking(part.text); else output.onContent(part.text);
    }
    for (const q of cand?.groundingMetadata?.webSearchQueries || []) {
      if (!queries.has(q)) { queries.add(q); onEvent({ type: "search", query: q }); }
    }
    if (cand?.finishReason) finish = cand.finishReason;
    const u = c.usageMetadata;
    if (u) { outTokens = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0); total = u.totalTokenCount || total; }
  }
  countTokens(model, total);
  if (outTokens) output.setExact(outTokens);
  if (blocked) throw new Error(`Google declined the request (${blocked}).`);

  let parsed;
  try { parsed = parseJsonLoose(output.out.content); } catch { /* reported below */ }
  const itinerary = normalizeItinerary(parsed, Number(trip.travelers) || 1, trip.people);
  if (!itinerary) {
    const why = STOP_ERRORS[finish];
    throw new Error(`${model} ${why ? `${why}, without` : "didn't return"} a usable itinerary.${output.out.content ? `\n\nIts answer began:\n${output.out.content.slice(0, 600)}` : ""}`);
  }
  // What happened on the way, at the top of the planning notes.
  const r = researched as Awaited<ReturnType<typeof plannerResearch>> | null;
  const viaPlanner = trip.research && !got.search;
  const notes = [
    got.switched.length ? `Switched Gemini models when one reached its limit (${got.switched.join(", ")}).` : "",
    viaPlanner ? (r?.notes ? `Google Search isn't included for ${model} on this key's tier, so ${r.model} researched with the planner's own web search first.`
      : `Planned without web research: Google Search isn't included for ${model} on this key's tier${researchFailed ? `, and the planner's research didn't work (${researchFailed.slice(0, 200)})` : ""}.`) : "",
  ].filter(Boolean).join(" ");
  const reasoning = [notes, String(itinerary.planningNotes || "").trim()].filter(Boolean).join("\n\n");
  delete itinerary.planningNotes;
  // The pages the research read, and the ones its findings cite.
  const cited = [...(r?.urls || []), ...(r?.notes.match(/https?:\/\/[^\s\])>]+/g) || [])];
  if (!itinerary.sources?.length && cited.length) itinerary.sources = [...new Set(cited)];
  const extras = [billing === "free" ? "free tier" : "", viaPlanner ? (r?.notes ? "researched through the planner" : "no web research") : ""].filter(Boolean);
  return {
    itinerary, reasoning, thinking: output.out.thinking.trim().slice(0, 20000), durationMs: Date.now() - t0,
    tokens: output.out.tokens, engine: `${model} via Google Gemini${extras.length ? ` (${extras.join(", ")})` : ""}`, billing, searches: queries.size + (r?.searches || 0),
  };
};

// ---- One-off questions (the trip chat, helper tasks) ----

export interface GeminiAsk {
  model: string;
  prompt: string;
  /** JSON answers are asked for as JSON; the chat's answers are text. */
  json: boolean;
  images?: { type: string; data: string }[];
  signal: AbortSignal;
  retry: boolean;
  tick: (piece?: string, thought?: string) => void;
  /** Waiting out a limit, or switching to another model, in words. */
  onWait?: (text: string) => void;
}

export async function askGemini(a: GeminiAsk): Promise<string> {
  const parts = [...(a.images || []).map((i) => ({ inline_data: { mime_type: i.type, data: i.data } })), { text: a.prompt }];
  const temperature = a.retry ? Math.min(1, tune().temperature + 0.3) : undefined;
  const base = { contents: [{ role: "user", parts }] };
  const cfg = { ...(a.json ? { responseMimeType: "application/json" } : {}), ...(temperature != null ? { temperature } : {}) };
  const { res, model } = await geminiFetch({
    model: a.model, method: "streamGenerateContent?alt=sse", search: false, signal: a.signal, onStatus: a.onWait,
    bodies: () => [{ ...base, generationConfig: { ...cfg, thinkingConfig: { includeThoughts: true } } }, { ...base, generationConfig: cfg }, base],
  });
  let text = "", total = 0;
  for await (const c of chunks(res)) {
    if (c.promptFeedback?.blockReason) throw new Error(`Google declined the request (${c.promptFeedback.blockReason}).`);
    for (const part of c.candidates?.[0]?.content?.parts || []) {
      if (typeof part.text !== "string" || !part.text) continue;
      if (part.thought) a.tick("", part.text);
      else { text += part.text; a.tick(part.text); }
    }
    total = c.usageMetadata?.totalTokenCount || total;
  }
  countTokens(model, total);
  return text;
}