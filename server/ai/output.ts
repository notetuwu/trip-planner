// Helpers for model output: token counts, tidying itineraries, and pulling JSON out of replies.
import type { Itinerary } from "../../shared/types";
import { groupsFromText } from "../../shared/groups";
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
  groupsFromText(it.days);
  for (const d of it.days) tidyStops(d);
  it.totalEstimatedCost = Number(it.totalEstimatedCost) || it.days.reduce((n: number, d: any) => n + d.estimatedCost, 0);
  it.summary = String(it.summary ?? "");
  if (Array.isArray(it.tips)) it.tips = it.tips.map((t: any) => String(t ?? "").trim()).filter(Boolean);
  // Models sometimes list a place under "didn't fit" and then say it's included after all.
  if (Array.isArray(it.unused)) {
    const planned = it.days.flatMap((d: any) => d.items.map((x: any) => simpleName(x.place)));
    it.unused = it.unused.filter((u: any) => {
      const name = simpleName(u?.place);
      if (!name) return false;
      if (/^\s*(already\s+)?(included|covered|scheduled|planned|visited)\b|\b(is|are|was|were)\s+(already\s+)?(included|covered|scheduled)\b/i.test(String(u.reason ?? ""))) return false;
      return !planned.some((p: string) => p === name || (name.length > 5 && p.includes(name)));
    });
  }
  return it;
}

/** Stops the travelers' notes say are already booked ("we have a teamLab Borderless booking on the 14th") lose
 *  "booking"/"bookAhead", so the plan doesn't tell them to book again. Matched on a distinctive word of the stop. */
export function dropBookedAgain(it: any, notes: string | undefined) {
  const said = String(notes || "").split(/(?<=[.!?\n])\s+|\balso\b/i).filter((s) => /\b(booked|booking|bookings|reserved|reservation|have tickets|got tickets)\b/i.test(s)).join(" ").toLowerCase();
  if (!said) return;
  const common = new Set("the and for with near park temple shrine museum tour tours tokyo osaka kyoto day trip booking store cafe restaurant".split(" "));
  for (const d of it.days || []) for (const x of d.items || []) {
    const words = String(x.place || "").toLowerCase().replace(/\(.*?\)/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !common.has(w));
    if (words.some((w) => said.includes(w))) { delete x.booking; delete x.bookAhead; }
  }
}

// Stops that are only somewhere you pass through: a station or the hotel ("Osaka Station (Shinkansen)", "Maple Tokyo
// Riverside Hotel", "Around the hotel"). Check-in and check-out stay; so does anything with a real description or cost.
const PASS_THROUGH = /^(around (the )?)?[^→]*\b(station|stn|terminal|platform|hotel)\b[^→]*$|駅$/i;
const KEEP = /check[- ]?(in|out)|breakfast|lunch|dinner|onsen|spa|museum|tower|observatory|park|garden|shrine|temple|castle/i;

/** Drops pass-through stops (their travel goes into the next stop's transport line) and the same place twice in one
 *  day (for one group). */
export function tidyStops(d: { items: any[] }) {
  const out: any[] = [], seen = new Set<string>();
  for (let i = 0; i < d.items.length; i++) {
    const x = d.items[i];
    const name = String(x.place || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    const filler = x.kind !== "meal" && !(Number(x.cost) > 0) && String(x.description || "").length < 120
      && PASS_THROUGH.test(name) && !KEEP.test(String(x.place));
    if (filler) {
      const next = d.items.slice(i + 1).find((y) => (y.group || "") === (x.group || ""));
      if (next && x.transport && !String(next.transport || "").includes(String(x.transport))) next.transport = [x.transport, next.transport].filter(Boolean).join("; ");
      continue;
    }
    const key = `${x.group || ""}|${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
    if (x.kind !== "meal" && x.kind !== "transfer" && !/→/.test(name) && seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  d.items = out;
}

/** Makes sure every booking is in the plan on its day: the stop for it gets its time (if given), "already booked"
 *  and its cost (or 0 when it's already paid); one that's missing is added at its time. */
export function ensureBookings(it: any, bookings: { name: string; date: string; from?: string; to?: string; cost?: number; countCost?: boolean }[] | undefined) {
  for (const b of (bookings || []).filter((x) => x?.name && x.date)) {
    const day = (it.days || []).find((d: any) => d.date === b.date);
    if (!day) continue;
    const words = b.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
    let x = day.items.find((y: any) => { const p = String(y.place || "").toLowerCase(); return p.includes(b.name.toLowerCase()) || (words.length > 0 && words.filter((w) => p.includes(w)).length >= Math.ceil(words.length / 2)); });
    if (!x) {
      x = { time: b.from || "", place: b.name, description: "", kind: "activity" };
      day.items.push(x);
    }
    if (b.from) x.time = b.from;
    if (!/already booked/i.test(x.description || "")) x.description = `Already booked${b.from ? ` (${b.from}${b.to ? `-${b.to}` : ""})` : ""}. ${x.description || ""}`.trim();
    delete x.booking; delete x.bookAhead;
    if (b.cost != null) x.cost = b.countCost ? b.cost : 0;
    // Back in time order (stops without a time keep their place).
    day.items.sort((p: any, q: any) => (p.time && q.time ? p.time.localeCompare(q.time) : 0));
    day.estimatedCost = day.items.reduce((n: number, y: any) => n + (Number(y.cost) || 0), 0);
  }
  if (Array.isArray(it.days) && it.days.length) it.totalEstimatedCost = it.days.reduce((n: number, d: any) => n + (Number(d.estimatedCost) || 0), 0);
}

/** Must-sees the plan left out without saying so go under "Didn't fit", so they don't vanish silently. A must-see
 *  counts as planned when a stop shares most of its words ("ZEN Chopsticks Workshop" for "ZEN Chopsticks Making
 *  Workshop Gion Kyoto"). */
export function addMissingMustSees(it: any, mustSee: string[]) {
  const words = (s: unknown) => simpleName(s).split(" ").filter((w) => w.length >= 3 || /[^\x00-\x7f]/.test(w));
  const stops = (it.days || []).flatMap((d: any) => (d.items || []).map((x: any) => new Set(words(x.place))));
  const listed = (it.unused || []).map((u: any) => simpleName(u?.place));
  const missing = mustSee.filter((title) => {
    const w = words(title);
    if (!w.length || listed.includes(simpleName(title))) return false;
    const need = Math.min(w.length, Math.max(1, Math.ceil(w.length / 2)));
    return !stops.some((s: Set<string>) => w.filter((x) => s.has(x)).length >= need);
  });
  if (missing.length) it.unused = [...(it.unused || []), ...missing.map((place) => ({ place, reason: "A must-see that isn't in the plan, and the model didn't say why. Ask for it in the trip chat." }))];
}

/** A place name for comparing: lowercase, without details in brackets or punctuation. */
const simpleName = (s: unknown) => String(s ?? "").toLowerCase().replace(/[({[].*$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

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

/**
 * The days already finished in a half-written itinerary (cut off or stopped mid-way), with the fields before them
 * (summary, planning notes…), so a retry can keep them and write only the rest. Null when no day is complete.
 */
export function partialDays(json: string): { head: Record<string, unknown>; days: any[] } | null {
  const m = /"days"\s*:\s*\[/.exec(json);
  if (!m) return null;
  let depth = 0, inStr = false, esc = false, start = -1, lastEnd = -1;
  const days: any[] = [];
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const ch = json[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}") {
      if (--depth === 0 && start >= 0) {
        try { days.push(JSON.parse(json.slice(start, i + 1))); lastEnd = i; } catch { break; }
      }
    } else if (ch === "]" && depth === 0) break;
  }
  if (!days.length) return null;
  let head: Record<string, unknown> = {};
  try { head = JSON.parse(`${json.slice(json.indexOf("{"), lastEnd + 1)}]}`); delete head.days; } catch { /* only the days, then */ }
  return { head, days };
}

/** Counts "date" keys in streamed itinerary JSON: each one starts another day. */
export const daysWritten = (json: string) => (json.match(/"date"\s*:/g) || []).length;
