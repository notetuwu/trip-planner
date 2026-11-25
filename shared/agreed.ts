// Stops the travelers settled with the trip chat ("Day 7: 09:00 check out, 12:15 Shinkansen, 14:30 Uber…"). The planner
// is told to keep them, but a small model can still write fewer, and the planner's tidying drops stops that look like
// somewhere you only pass through ("Uber from Odawara Station to the hotel"). What they signed off on is what they get:
// any agreed stop missing from the planner's day is put back, in time order.
import type { AgreedStop, ItineraryItem } from "./types";

const KINDS: ItineraryItem["kind"][] = ["sight", "activity", "meal", "transfer", "other"];

/** Whether a kind the chat wrote is one the plan knows ("transport" is a transfer; anything else unknown is other). */
export function planKind(kind: unknown): ItineraryItem["kind"] {
  const k = String(kind || "").toLowerCase();
  if (KINDS.includes(k as ItineraryItem["kind"])) return k as ItineraryItem["kind"];
  if (/transport|transfer|train|bus|metro|taxi|uber|drive|flight|ferry/.test(k)) return "transfer";
  if (/food|meal|lunch|dinner|breakfast|restaurant|cafe/.test(k)) return "meal";
  if (/sight|museum|temple|shrine|park|walk/.test(k)) return "sight";
  return k ? "other" : undefined;
}

const words = (s: string) => new Set(s.toLowerCase().replace(/\(.*?\)/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /[^\x00-\x7f]/.test(w)));
const minutes = (t: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };

/** Whether a stop in the plan is this agreed one: most of its name's words, or the same time and some of them. */
function same(x: ItineraryItem, a: AgreedStop): boolean {
  const want = words(a.place), have = words(x.place);
  if (!want.size) return x.place.trim().toLowerCase() === a.place.trim().toLowerCase();
  const shared = [...want].filter((w) => have.has(w)).length;
  if (shared >= Math.ceil(want.size / 2)) return true;
  const ta = minutes(a.time), tx = minutes(x.time);
  return shared > 0 && ta != null && tx != null && Math.abs(ta - tx) <= 15;
}

/** Puts back the agreed stops the planner's version of a day is missing; returns how many it put back. */
export function restoreAgreed(day: { items: ItineraryItem[] }, agreed: AgreedStop[]): number {
  const used = new Set<ItineraryItem>();
  const missing = agreed.filter((a) => {
    const hit = day.items.find((x) => !used.has(x) && same(x, a));
    if (hit) { used.add(hit); return false; }
    return true;
  });
  for (const a of missing) {
    const item: ItineraryItem = {
      time: a.time, place: a.place, description: a.note || "", fromList: false,
      ...(a.cost != null ? { cost: a.cost, costPer: "group" as const } : {}),
      ...(planKind(a.kind) ? { kind: planKind(a.kind) } : {}),
    };
    // In time order: before the first stop that starts later (stops without a time stay where they are).
    const t = minutes(a.time);
    const at = t == null ? -1 : day.items.findIndex((x) => (minutes(x.time) ?? -1) > t);
    if (at < 0) day.items.push(item); else day.items.splice(at, 0, item);
  }
  return missing.length;
}
