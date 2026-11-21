// Opening-hours warnings: stops that are real OpenStreetMap places with listed hours get checked (by the server)
// against the day and time they're planned for, e.g. "Closed on Monday" or "Closes at 17:00".
import type { HoursCheck, HoursResult } from "../../../shared/types";
import { $$, api, esc } from "../core/dom";
import { state } from "../core/state";
import { endMin, toMin } from "../export/ics";
import { byTitleMap, exactPoi } from "../geo/item-loc";
import { stayLoc, stayOn } from "../geo/locate";

const results = new Map<string, HoursResult>();
const keyOf = (c: HoursCheck) => [c.hours, c.date, c.time, c.minutes, c.cc].join("|");

/** The checks for every stop whose position is a known place with opening hours, by "day-item". */
function checks() {
  const it = state.itinerary, byTitle = byTitleMap(), out = new Map<string, HoursCheck>();
  if (!it) return out;
  it.days.forEach((d, di) => d.items.forEach((x, xi) => {
    if (x.kind === "transfer") return;
    const poi = exactPoi(x, d, byTitle);
    if (!poi?.hours) return;
    const start = toMin(x.time), stay = stayOn(d);
    out.set(`${di}-${xi}`, {
      hours: poi.hours, date: d.date, time: start == null ? "" : x.time.slice(0, 5),
      minutes: start == null ? 60 : endMin(d, xi, start) - start, cc: (stay && stayLoc(stay)?.cc) || "", lat: poi.lat, lng: poi.lng,
    });
  }));
  return out;
}

function show(byItem: Map<string, HoursCheck>) {
  for (const el of $$("[data-hours]")) {
    const c = byItem.get(el.dataset.hours!), r = c && results.get(keyOf(c));
    const warn = r && r.status !== "ok" && r.status !== "unknown";
    el.hidden = !warn;
    el.innerHTML = warn ? `🕒 ${esc(r.text)}` : "";
  }
}

let pending = false;
/** Shows warnings for the rendered itinerary, asking the server about anything not checked yet. */
export async function checkOpeningHours() {
  const byItem = checks();
  show(byItem);
  const todo = [...new Map([...byItem.values()].filter((c) => !results.has(keyOf(c))).map((c) => [keyOf(c), c])).values()];
  if (!todo.length || pending) return;
  pending = true;
  try {
    const res = await api<HoursResult[]>("/api/hours", { method: "POST", body: JSON.stringify({ checks: todo }) });
    todo.forEach((c, i) => results.set(keyOf(c), res[i] || { status: "unknown", text: "" }));
  } catch {
    todo.forEach((c) => results.set(keyOf(c), { status: "unknown", text: "" }));
  } finally { pending = false; }
  show(checks());
}
