// Calendar export (.ics): an all-day event per day plus an event per timed stop. Times are "floating" (no time zone),
// so a phone shows them at the local time wherever it is, which is what an itinerary means by "09:30".
import type { Day, Itinerary, ItineraryItem } from "../../../shared/types";

const esc = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 bytes are folded: continued on the next line after a space. */
function fold(line: string) {
  const out: string[] = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const ymd = (date: string) => date.replace(/-/g, "");
export const toMin = (t: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const stamp = (date: string, min: number) => `${ymd(date)}T${String(Math.floor(min / 60)).padStart(2, "0")}${String(min % 60).padStart(2, "0")}00`;
const nextDay = (date: string) => new Date(Date.parse(date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);

/** A stop ends when the next stop of the same group (or of everyone) starts, else after an hour. */
export function endMin(d: Day, xi: number, start: number) {
  const g = d.items[xi].group || "";
  for (let i = xi + 1; i < d.items.length; i++) {
    const y = d.items[i];
    if (y.group && g && y.group !== g) continue;
    const t = toMin(y.time);
    if (t != null && t > start) return Math.min(t, 23 * 60 + 59);
  }
  return Math.min(start + 60, 23 * 60 + 59);
}

export interface IcsOptions {
  /** Link to open a stop in maps. */
  mapsUrl?: (x: ItineraryItem, d: Day) => string;
  /** Exact position of a stop, when known. */
  loc?: (x: ItineraryItem, d: Day) => { lat: number; lng: number } | null;
  now?: Date;
}

export function itineraryIcs(it: Itinerary, opts: IcsOptions = {}) {
  const dtstamp = (opts.now || new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const uid = (s: string) => `${s.replace(/[^\w-]/g, "")}@trip-planner.local`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//local-trip-planner//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(it.destination ? `${it.destination} trip` : "Trip")}`];
  const event = (fields: string[]) => lines.push("BEGIN:VEVENT", `DTSTAMP:${dtstamp}`, ...fields, "END:VEVENT");

  it.days.forEach((d, di) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return;
    event([
      `UID:${uid(`day-${d.date}-${di}`)}`, `DTSTART;VALUE=DATE:${ymd(d.date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(d.date))}`,
      `SUMMARY:${esc(`${d.title || d.city}${d.city && d.title !== d.city ? ` (${d.city})` : ""}`)}`,
      ...(d.notes ? [`DESCRIPTION:${esc(d.notes)}`] : []), "TRANSP:TRANSPARENT",
    ]);
    d.items.forEach((x, xi) => {
      const start = toMin(x.time);
      if (start == null) return;
      const at = opts.loc?.(x, d);
      const desc = [x.description, x.transport && `Getting there: ${x.transport}`, x.bookAhead && `Book ${x.bookAhead}`, opts.mapsUrl?.(x, d)].filter(Boolean).join("\n\n");
      event([
        `UID:${uid(`stop-${d.date}-${xi}`)}`, `DTSTART:${stamp(d.date, start)}`, `DTEND:${stamp(d.date, endMin(d, xi, start))}`,
        `SUMMARY:${esc(x.group ? `${x.place} (${x.group})` : x.place)}`, `LOCATION:${esc(`${x.place}, ${d.city}`)}`,
        ...(at ? [`GEO:${at.lat.toFixed(5)};${at.lng.toFixed(5)}`] : []),
        ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []),
      ]);
    });
  });
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
