// Gemini's exact limits, read from the person's own Google Cloud project (Settings → AI models → Google Gemini → Exact
// limits): the Service Usage API lists every quota of the Gemini API (generativelanguage.googleapis.com) for the
// project, per model (requests a day, requests a minute), the same numbers AI Studio shows; the Cloud Billing API says
// whether billing is on (which decides whether the free-tier quotas or the paid ones apply). Read with the Google
// sign-in's read-only Cloud access (the newer Cloud Quotas API would need full read-and-write access, so it isn't
// used); nothing here spends any of the Gemini key's requests.
//
// A quota's value: a number; -1 for unlimited; 0 or none for "none on this tier" (Pro models on the free tier).
import { errMsg } from "../config";
import { readSettings } from "../settings";
import { client, cloudGet, hasCloudAccess } from "../sync/google";

// SERVICE_USAGE_URL / CLOUD_BILLING_URL point elsewhere, e.g. a mock server in tests.
const USAGE = (process.env.SERVICE_USAGE_URL || "https://serviceusage.googleapis.com/v1beta1").replace(/\/+$/, "");
const BILLING = (process.env.CLOUD_BILLING_URL || "https://cloudbilling.googleapis.com/v1").replace(/\/+$/, "");
const SERVICE = "generativelanguage.googleapis.com";

/** null: none on this tier; -1: unlimited. */
export type Limit = number | null;
export interface GeminiQuotas {
  project: string;
  /** Whether billing is on for the project (null: couldn't be read). */
  billing: boolean | null;
  /** Per model, by the quota's model name (e.g. "gemini-3.8-flash", without "-preview"). */
  perDay: Record<string, Limit>;
  perMinute: Record<string, Limit>;
  at: number;
}

/** The project whose quotas are read: the one entered under Exact limits, else the client's own (a Google client ID
 *  starts with its project's number: "123456789012-….apps.googleusercontent.com"). */
export function quotaProject(): string {
  return readSettings().google.project || client()?.id.match(/^(\d{6,20})-/)?.[1] || "";
}

/** Whether exact limits are wanted and can be read (ticked, and signed in with read-only Cloud access). */
export const quotasWanted = () => readSettings().google.quotas;
export const quotasReady = () => quotasWanted() && hasCloudAccess() && !!quotaProject();

/** What Google said, in words that say what to do. */
function explain(what: string, status: number, json: any, project: string) {
  const msg = String(json?.error?.message || ""), all = `${msg} ${JSON.stringify(json?.error?.details || [])}`;
  if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(all)) return "The Google sign-in doesn't allow this yet. Sign in again (Settings → Accounts) and leave every box ticked.";
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(all)) return `The ${what} API isn't switched on for project ${project}. Switch it on in the Google Cloud Console, wait a minute, then check again.`;
  if (status === 403) return `This Google account may not read project ${project} (${msg.slice(0, 120) || "permission denied"}). Is it the project of your Gemini key, and are you signed in with its owner?`;
  if (status === 404) return `Google has no project ${project}. Check the project under Exact limits.`;
  return `${what}: Google answered ${status}${msg ? `: ${msg.slice(0, 160)}` : ""}`;
}

/** Reads the quota list (Service Usage's metrics) into the requests-a-day and requests-a-minute limits per model, for
 *  the tier that applies. */
export function readQuotas(metrics: any[], billing: boolean | null) {
  const perDay: Record<string, Limit> = {}, perMinute: Record<string, Limit> = {};
  const free = billing !== true;
  for (const m of metrics) {
    const metric = String(m.metric || "").split("/").pop()!;
    // Requests to generate content per model, not tokens, grounding, files…
    if (/free_tier/.test(metric) !== free || !/^generate_(content_(free_tier_|paid_tier_(\d_)?)?requests|requests_per_model(_per_day)?)$/.test(metric)) continue;
    for (const l of m.consumerQuotaLimits || []) {
      const unit = String(l.unit || "");
      if (!unit.includes("{model}")) continue;
      const into = unit.includes("/d/") ? perDay : unit.includes("/min/") ? perMinute : null;
      if (!into) continue;
      for (const b of l.quotaBuckets || []) {
        const model = b.dimensions?.model;
        if (!model) continue;
        const n = Number(b.effectiveLimit ?? 0), value: Limit = Number.isFinite(n) && n !== 0 ? n : null;
        // Several paid metrics may list the same model: the largest is what the project gets at least.
        if (!(model in into) || (value ?? 0) > (into[model] ?? 0) || value === -1) into[model] = value;
      }
    }
  }
  return { perDay, perMinute };
}

let cache: { at: number; quotas: GeminiQuotas | null; error: string } | null = null;
const TTL = 10 * 60_000;

/** The project's Gemini limits (cached for 10 minutes; `fresh` reads them again). null with an error when they can't be
 *  read; null without one when they aren't wanted or the sign-in doesn't allow it. */
export async function geminiQuotas(fresh = false): Promise<{ quotas: GeminiQuotas | null; error: string }> {
  if (!quotasWanted()) return { quotas: null, error: "" };
  if (!hasCloudAccess()) return { quotas: null, error: "Connect Google (again), so the planner may read your project's limits." };
  const project = quotaProject();
  if (!project) return { quotas: null, error: "Enter your Gemini key's Google Cloud project (its ID or number)." };
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache;
  try {
    const b = await cloudGet(`${BILLING}/projects/${project}/billingInfo`);
    const billing = b.status === 200 ? b.json.billingEnabled === true : null;
    const metrics: any[] = [];
    let page = "";
    do {
      const r = await cloudGet(`${USAGE}/projects/${project}/services/${SERVICE}/consumerQuotaMetrics?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
      if (r.status !== 200) throw new Error(explain("Service Usage", r.status, r.json, project));
      metrics.push(...(r.json.metrics || []));
      page = r.json.nextPageToken || "";
    } while (page);
    const read = readQuotas(metrics, billing);
    if (!Object.keys(read.perDay).length) throw new Error(`Project ${project} lists no daily Gemini limits. Is it the project of your Gemini key? (AI Studio → API keys shows each key's project.)`);
    cache = { at: Date.now(), quotas: { project, billing, ...read, at: Date.now() }, error: b.status === 200 ? "" : explain("Cloud Billing", b.status, b.json, project) };
  } catch (e) {
    cache = { at: Date.now(), quotas: null, error: errMsg(e) };
  }
  return cache;
}

/** Forget what was read (after signing in again or changing the project). */
export const forgetQuotas = () => { cache = null; };

/**
 * A model's limit from the quota list. The list names models without "-preview…", "-latest" or version numbers, so
 * the catalog's name is tried as it is, then without those. undefined: the list doesn't have it.
 */
export function limitFor(list: Record<string, Limit>, model: string): Limit | undefined {
  const names = [model, model.replace(/-preview(-[\w.-]+)?$/, ""), model.replace(/-(exp|experimental)(-[\w.-]+)?$/, ""), model.replace(/-\d{3}$/, "")];
  for (const n of names) if (n in list) return list[n];
  return undefined;
}
