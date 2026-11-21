// Helpers for model output: token counts, tidying itineraries, and pulling JSON out of replies.
import type { Itinerary } from "../../shared/types";
import type { OnEvent } from "./types";

/** Reports generated tokens to the browser, at most ~5 times a second (forced for exact counts). */
export function tokenMeter(onEvent: OnEvent, estimated: boolean) {
  let last = 0;
  return (count: number, { force = false, perSec }: { force?: boolean; perSec?: number } = {}) => {
    const now = Date.now();
    if (!force && now - last < 200) return;
    last = now;
    onEvent({ type: "tokens", count: Math.round(count), estimated, ...(perSec ? { perSec } : {}) });
  };
}

/** Small models sometimes leave fields out; fill the gaps so the page can render what they did produce. */
export function normalizeItinerary(it: any, travelers = 1): Itinerary | null {
  if (!it || !Array.isArray(it.days) || !it.days.length) return null;
  for (const d of it.days) {
    d.items = Array.isArray(d.items) ? d.items.filter((x: any) => x && x.place) : [];
    for (const x of d.items) {
      x.time = String(x.time ?? "").trim(); x.description = String(x.description ?? "");
      // Some models write a sentence in the time field; keep it as description text instead.
      if (x.time && !/^\d{1,2}:\d{2}/.test(x.time)) { x.description = `${x.time}. ${x.description}`.trim(); x.time = ""; }
      x.place = String(x.place).replace(/\s*[({]\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*[)}]\s*$/, ""); // drop copied "(lat, lng)"
      // "All" / everyone in the group isn't a split.
      if (!x.group || /^(all|everyone|everybody|together|whole group|both|group)$/i.test(String(x.group).trim()) || (travelers > 1 && x.people >= travelers)) {
        delete x.group; delete x.people;
      }
    }
    d.estimatedCost = Number(d.estimatedCost) || d.items.reduce((n: number, x: any) => n + (Number(x.cost) || 0), 0);
    d.city = String(d.city ?? ""); d.title = String(d.title ?? d.city); d.date = String(d.date ?? "");
  }
  it.totalEstimatedCost = Number(it.totalEstimatedCost) || it.days.reduce((n: number, d: any) => n + d.estimatedCost, 0);
  it.summary = String(it.summary ?? "");
  return it;
}

/** The (possibly still incomplete) planningNotes string from streamed JSON. */
export function partialNotes(json: string): string | null {
  const m = json.match(/"planningNotes"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`); } catch { return null; }
}

/** The JSON object in a reply, also when wrapped in a ``` fence or surrounded by chatter. */
export function parseJsonLoose(text: string): any {
  const s = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null;
}

/** Counts "date" keys in streamed itinerary JSON: each one starts another day. */
export const daysWritten = (json: string) => (json.match(/"date"\s*:/g) || []).length;
