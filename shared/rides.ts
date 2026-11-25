// The rides of a public transport leg (from Transitous: line, colour, direction, stops) in words, and whether the plan's
// own words for that leg name the same line. When they name another one, or none, the plan takes the timetable's.
// No page code here, so it can be tested.
import type { Ride } from "./geo";

/** "Bus", "Tram", "Metro", "Train", "Boat", "Cable car", "Funicular" for Transitous's kind of vehicle. On a train leg any
 *  rail is a train (Osaka's metro comes as REGIONAL_RAIL), so the words don't turn the leg into another kind. */
export function rideKind(mode: string, legMode = "", agency = ""): string {
  if (/BUS|COACH/.test(mode)) return "Bus";
  if (mode === "FERRY") return "Boat";
  if (mode === "AERIAL_LIFT") return "Cable car";
  if (mode === "FUNICULAR") return "Funicular";
  if (legMode === "train") return "Train";
  // A metro filed as rail (Japan's data has Osaka Metro as regional rail): its operator's name says what it is.
  if (/metro|subway|u-?bahn/i.test(agency) && !/BUS|TRAM/.test(mode)) return "Metro";
  if (mode === "TRAM") return "Tram";
  if (/SUBWAY|METRO/.test(mode)) return "Metro";
  return "Train";
}

/** What a ride is called: "Bus 5", "Train JC (JR Chūō Rapid Line)", "Train (Osaka Metro)". */
export function rideName(r: Ride, legMode = ""): string {
  const kind = rideKind(r.mode, legMode, r.agency);
  if (r.line) return `${kind} ${r.line}${r.name && !r.name.includes(r.line) ? ` (${r.name})` : ""}`;
  if (r.name) return `${kind} (${r.name})`;
  return r.agency ? `${kind} (${r.agency})` : kind;
}

/** One ride in a line: "Bus 5 towards Kriens, Busschleife: Luzern, Moosegg → Kriens, Busschleife, 9 stops". */
export function rideLine(r: Ride, legMode = ""): string {
  const n = r.stops.length + 1;
  return `${rideName(r, legMode)}${r.to ? ` towards ${r.to}` : ""}: ${r.on.n} → ${r.off.n}, ${n} stop${n === 1 ? "" : "s"}`;
}

/** The plan's text for a leg, as the timetable has it: which line towards where ("…, then …" for a change). Where to get
 *  on and off and the stops are shown with the leg (rideLine). */
export const ridesText = (rides: Ride[], legMode = "") => rides.map((r) => `${rideName(r, legMode)}${r.to ? ` towards ${r.to}` : ""}`).join(", then ");

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const norm = (s: string) => plain(s).replace(/[\s-]+/g, "");

/** The line numbers the text names: "bus 5", "tram no. 2", "line 18", "U2", "S-Bahn S41", "#710". */
export function linesNamed(text: string): string[] {
  const out = new Set<string>(), t = plain(text);
  const kinds = "bus(?:es)?|tram|trams|line|linie|ligne|linea|metro|subway|u-?bahn|s-?bahn|route|no\\.?|number|#";
  for (const m of t.matchAll(new RegExp(`(?:${kinds})\\s*(?:no\\.?\\s*)?#?\\s*([a-z]{0,3}\\s?\\d{1,4}[a-z]?)\\b`, "g"))) out.add(norm(m[1]));
  for (const m of t.matchAll(/\b([sur]\d{1,3})\b/g)) out.add(norm(m[1]));
  return [...out];
}

/** Words of a line's full name that tell it from others (not "line", "rapid", "JR"). */
const nameWords = (name: string) => plain(name).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !/^(line|lines|rapid|local|express|limited|the|and|jr|railway|metro|subway|tram|bus)$/.test(w) && !/[^\x00-\x7f]/.test(w));

/** The kinds of vehicle the text names ("bus", "metro", "train"…); a metro may come as rail in the timetable (Japan's
 *  data has Osaka Metro as regional rail) and the other way round. */
const KINDS: [RegExp, string[]][] = [
  [/\b(bus|buses|postbus|postauto|coach)\b/, ["Bus"]],
  [/\b(trams?|streetcar|light rail)\b/, ["Tram"]],
  [/\b(metro|subway|u-?bahn|underground|tube)\b/, ["Metro", "Train"]],
  [/\b(train|trains|rail|railway|s-?bahn|shinkansen|jr|railjet|intercity|regional)\b/, ["Train", "Metro"]],
];
/** The rides are the kind of vehicle the text names (or it names none). A bus where the plan says tram is another way
 *  of going, not the timetable's word for the same one: the plan isn't changed for that. */
export function kindsAgree(text: string, rides: Ride[], legMode = ""): boolean {
  const t = plain(text), ok = new Set(KINDS.filter(([re]) => re.test(t)).flatMap(([, k]) => k));
  return !ok.size || rides.every((r) => ok.has(rideKind(r.mode, legMode, r.agency)) || ok.has(rideKind(r.mode)));
}

/**
 * Whether the plan's text for a leg says the same as the timetable. "same": it names these lines (or doesn't need to:
 * the timetable gives no line to compare); "other": it names another line; "none": it names no line at all.
 */
export function compareRides(text: string, rides: Ride[]): "same" | "other" | "none" {
  const named = rides.filter((r) => r.line || r.name);
  if (!named.length) return "same";
  const t = plain(text), refs = linesNamed(text);
  const ours = new Set(named.flatMap((r) => (r.line ? [norm(r.line)] : [])));
  const said = (r: Ride) => (!!r.line && new RegExp(`(^|[^\\p{L}\\p{N}])${plain(r.line).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u").test(t))
    || (!!r.name && nameWords(r.name).some((w) => t.includes(w)));
  if (refs.length) return refs.every((ref) => ours.has(ref)) || named.every(said) ? "same" : "other";
  return named.some(said) ? "same" : "none";
}
