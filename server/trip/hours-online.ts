// Opening hours looked up on the web, for stops OpenStreetMap has no hours for (after a plan, when "Check opening
// hours online" is on): one search per stop, and the bits of the results that talk about opening times. The page hands
// them to the model with each stay's days, which moves or swaps what's closed (see web/src/generate/run.ts).
import { webSearch } from "../research/search";
import type { Report } from "../util/progress-stream";

export interface HoursQuery { place: string; town: string }

/** The lines of search results that mention times or days, so the model gets the hours and not the whole page. */
export function hoursLines(text: string, max = 700) {
  const parts = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const useful = parts.filter((l) => /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(am|pm)\b|\b(open|opening|hours|closed|öffnungszeiten|geöffnet|geschlossen|ruhetag|orari|chiuso|horaires|fermé|mon|tue|wed|thu|fri|sat|sun|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i.test(l));
  return (useful.length ? useful : parts).join(" · ").slice(0, max);
}

export async function lookupHours(body: { stops?: HoursQuery[] }, report: Report) {
  const stops = (Array.isArray(body.stops) ? body.stops : []).filter((s) => s?.place).slice(0, 60);
  const results: string[] = [];
  for (const [i, s] of stops.entries()) {
    report({ type: "status", text: `Looking up opening hours online (${i + 1} of ${stops.length}): ${s.place}…` });
    const q = `${String(s.place).slice(0, 100)} ${String(s.town || "").slice(0, 60)} opening hours`;
    const text = await webSearch(q).catch(() => "");
    results.push(/^No results/.test(text) ? "" : hoursLines(text));
  }
  return { results };
}
