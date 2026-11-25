// How a transfer stop goes, from its own words (no page state, so the tests can use it too).
import type { ItineraryItem, TravelMode } from "../../../shared/types";

/** What a transfer stop says about how it goes: "(train)" in its name first, else its transport line. */
export function modeOf(x: ItineraryItem): TravelMode {
  const tag = String(x.place).match(/\(([^)]*)\)\s*$/)?.[1] || "";
  // A transfer's own name says how it goes too ("Uber Odawara → Maple Stay Hotel", "Shinkansen to Odawara").
  const name = x.kind === "transfer" ? String(x.place) : "";
  for (const text of [tag, String(x.transport || ""), name]) {
    const t = text.toLowerCase();
    // A taxi named in the stop's name is the ride itself ("Taxi to the JR station" isn't a train).
    if (text === name && /\b(taxi|taxis|cab|uber|lyft|grab|didi|rideshare)\b/.test(t)) return "car";
    if (/\b(flight|fly|flying|plane|airline|air)\b/.test(t)) return "flight";
    if (/\b(ferry|boat|ship|steamer|steamboat|cruise|vaporetto|schiff)\b/.test(t)) return "ferry";
    if (/\b(train|rail|railway|shinkansen|ice|tgv|railjet|jr|metro|subway|s-bahn|bahn|tram|intercity|express|cog ?wheel|cog railway|rack railway|funicular)\b/.test(t)) return "train";
    if (/\b(bus|coach|flixbus)\b/.test(t)) return "bus";
    if (/\b(car|drive|driving|motorway|autobahn|taxi|taxis|cab|uber|lyft|grab|didi|go taxi|rideshare|ride-share)\b/.test(t)) return "car";
    if (/\b(bike|bicycle|cycling)\b/.test(t)) return "bike";
  }
  return "";
}
