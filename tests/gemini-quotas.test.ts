// Gemini's exact limits from the Service Usage API: the free-tier or the paid quotas, as billing says; a model without
// a value (or 0) has none on that tier, -1 is unlimited; the catalog's names ("-preview…") find their quota.
import { describe, expect, it } from "vitest";
import { limitFor, readQuotas } from "../server/ai/gemini-quotas";

const metric = (name: string, unit: string, values: Record<string, string | undefined>) => ({
  metric: `generativelanguage.googleapis.com/${name}`,
  consumerQuotaLimits: [{ unit, quotaBuckets: [{ effectiveLimit: "7" }, ...Object.entries(values).map(([model, v]) => ({ ...(v === undefined ? {} : { effectiveLimit: v }), dimensions: { model } }))] }],
});
const DAY = "1/d/{project}/{model}", MIN = "1/min/{project}/{model}";
const METRICS = [
  metric("generate_content_free_tier_requests", DAY, { "gemini-3.8-flash": "20", "gemini-3.5-flash-lite": "500", "gemini-4-argon": undefined, "gemini-3.8-live": "-1", "gemini-3.1-flash-lite": "500" }),
  metric("generate_content_free_tier_requests", MIN, { "gemini-3.8-flash": "5", "gemini-3.5-flash-lite": "15", "gemini-4-argon": "0" }),
  metric("generate_requests_per_model_per_day", DAY, { "gemini-3.8-flash": "10000", "gemini-4-argon": "1000" }),
  metric("generate_content_free_tier_input_token_count", MIN, { "gemini-3.8-flash": "250000" }),
];

describe("Gemini's limits from the project's quotas", () => {
  it("reads the free-tier quotas without billing: none (no value or 0), a number, or unlimited", () => {
    const q = readQuotas(METRICS, false);
    expect(q.perDay).toEqual({ "gemini-3.8-flash": 20, "gemini-3.5-flash-lite": 500, "gemini-4-argon": null, "gemini-3.8-live": -1, "gemini-3.1-flash-lite": 500 });
    expect(q.perMinute).toEqual({ "gemini-3.8-flash": 5, "gemini-3.5-flash-lite": 15, "gemini-4-argon": null });
  });

  it("reads the paid quotas with billing on (and not knowing counts as free)", () => {
    expect(readQuotas(METRICS, true).perDay).toEqual({ "gemini-3.8-flash": 10000, "gemini-4-argon": 1000 });
    expect(readQuotas(METRICS, null).perDay["gemini-3.8-flash"]).toBe(20);
  });

  it("finds a catalog model's quota under its plain name", () => {
    const { perDay } = readQuotas(METRICS, false);
    expect(limitFor(perDay, "gemini-3.8-flash")).toBe(20);
    expect(limitFor(perDay, "gemini-3.1-flash-lite-preview")).toBe(500);
    expect(limitFor(perDay, "gemini-3.1-flash-lite-preview-09-2026")).toBe(500);
    expect(limitFor(perDay, "gemini-4-argon")).toBeNull();
    expect(limitFor(perDay, "gemini-flash-latest")).toBeUndefined();
  });
});
