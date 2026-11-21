// Checks planned visits against OpenStreetMap opening hours ("Tu-Su 10:00-18:00; PH off"), including public holidays
// where the country is known. Times are wall-clock times at the destination, so they're compared as plain local times.
import opening_hours from "opening_hours";
import type { HoursCheck, HoursResult } from "../../shared/types";

const at = (date: string, time: string) => {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = (time || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, h || 0, mi || 0);
};
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const weekday = (d: Date) => d.toLocaleDateString("en", { weekday: "long" });

function parse(c: HoursCheck) {
  const where = { lat: String(c.lat), lon: String(c.lng), address: { country_code: (c.cc || "").toLowerCase(), state: "" } };
  try { return new opening_hours(c.hours, where); }
  catch {
    // Holiday rules need a region the library may not know; without it, PH rules can't be evaluated.
    try { return new opening_hours(c.hours, null); } catch { return null; }
  }
}

export function checkHours(c: HoursCheck): HoursResult {
  if (!c?.hours || !/^\d{4}-\d{2}-\d{2}$/.test(c.date || "")) return { status: "unknown", text: "" };
  const oh = parse(c);
  if (!oh) return { status: "unknown", text: "" };
  try {
    const dayStart = at(c.date, "00:00"), dayEnd = new Date(dayStart.getTime() + 864e5);
    const open = oh.getOpenIntervals(dayStart, dayEnd);
    const spans = open.filter(([, , unknown]) => !unknown).map(([a, b]) => `${hhmm(a)}–${b.getTime() >= dayEnd.getTime() ? "24:00" : hhmm(b)}`).join(", ");
    const listed = `OpenStreetMap: ${c.hours}`;
    if (!open.length) return { status: "closed-all-day", text: `Closed on ${weekday(dayStart)} (${listed})` };
    if (!/^\d{1,2}:\d{2}/.test(c.time || "")) return { status: "ok", text: "" };

    const start = at(c.date, c.time), end = new Date(start.getTime() + Math.max(15, c.minutes || 60) * 60000);
    const state = oh.getStateString(start, true);
    if (state === "unknown") return { status: "unknown", text: "" };
    if (state === "closed") {
      const next = oh.getNextChange(start, dayEnd);
      if (next && oh.getState(next) && next.getTime() - start.getTime() <= 90 * 60000) {
        return { status: "opens-later", text: `Opens at ${hhmm(next)} (${listed})` };
      }
      return { status: "closed", text: `Closed at ${c.time}${spans ? `; open ${spans}` : ""} (${listed})` };
    }
    const closes = oh.getNextChange(start, end);
    if (closes && closes.getTime() - start.getTime() < (end.getTime() - start.getTime()) - 15 * 60000) {
      return { status: "closes-early", text: `Closes at ${hhmm(closes)} (${listed})` };
    }
    return { status: "ok", text: "" };
  } catch {
    return { status: "unknown", text: "" };
  }
}
