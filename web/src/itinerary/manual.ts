// Planning by hand: an empty plan made from the stays (a day for every date from the first arrival to the final
// departure, each in its stay's town), and "Add a stop" under every day: a time, a place found as you type (or just a
// name), and what it is. A generated plan gets the same row, and an empty day can still be planned with its Re-plan
// button.
import type { Day, GeoHit, ItineraryItem } from "../../../shared/types";
import { $, api, esc, toast } from "../core/dom";
import { addDays } from "../core/format";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { askConfirm } from "../core/ask";
import { countryCodes, stayLoc } from "../geo/locate";
import { geocodeItems } from "../geo/item-loc";
import { addStop } from "../map/edit";
import { drawMap } from "../map/draw";
import { map } from "../map/map";
import { renderItinerary } from "./render";

/** The days the stays cover, empty: each night's date in its stay's town, and the departure day after the last night.
 *  A string says what's missing instead. */
export function emptyDays(stays = state.stays): Day[] | string {
  const list = stays.filter((s) => s.city?.trim() && Number(s.nights) > 0);
  if (!list.length) return "Add a stay with at least one night first.";
  if (!list[0].start) return "Give the first stay an arrival date first.";
  const days: Day[] = [];
  for (const s of list) {
    if (!s.start) return `Give the stay in ${s.city} an arrival date.`;
    for (let n = 0; n < Number(s.nights); n++) {
      const date = addDays(s.start, n);
      if (!days.some((d) => d.date === date)) days.push({ date, city: s.city, title: n === 0 && days.length ? `To ${s.city.split(",")[0]}` : "", estimatedCost: 0, items: [] });
    }
  }
  const last = list[list.length - 1], out = addDays(last.start, Number(last.nights));
  if (!days.some((d) => d.date === out)) days.push({ date: out, city: last.city, title: "Departure", estimatedCost: 0, items: [] });
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** Starts an empty plan to fill in by hand (asking first when there's a plan already; Undo puts it back). */
export async function startEmptyPlan() {
  const days = emptyDays();
  if (typeof days === "string") { toast(days); return; }
  const had = state.itinerary, meta = state.meta;
  if (had?.days.length && !await askConfirm({ title: "Replace the plan with an empty one?", text: `The ${had.days.length} days planned now are replaced by ${days.length} empty days from your stays. You can undo it right after.`, ok: "Replace", danger: true })) return;
  state.itinerary = { summary: "", destination: state.stays[0]?.city.split(",")[0] || "", totalEstimatedCost: 0, days };
  state.meta = null;
  save(); renderItinerary(); drawMap({ fit: true });
  document.querySelector("#output")?.scrollTo({ top: 0 });
  toast(`An empty plan of ${days.length} days: add stops with “Add a stop” under each day`, had ? () => { state.itinerary = had; state.meta = meta; save(); renderItinerary(); drawMap({ fit: true }); } : undefined);
}

/** The row under a day's stops. */
export const addStopHtml = (di: number, empty: boolean) =>
  `<div class="add-stop" data-add-stop="${di}">${empty ? `<span class="hint">Nothing planned yet.</span>` : ""}<button type="button" class="link-btn add-stop-btn" data-add-open="${di}">${icon("plus")} Add a stop</button></div>`;

const toMin = (t: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** An hour and a half after the day's last stop (09:00 on an empty day). */
function nextTime(di: number) {
  const times = (state.itinerary?.days[di]?.items || []).map((x) => toMin(x.time)).filter((m): m is number => m != null);
  return times.length ? hhmm(Math.min(23 * 60, Math.max(...times) + 90)) : "09:00";
}

const KINDS: [NonNullable<ItineraryItem["kind"]>, string][] = [["sight", "Sight"], ["activity", "Activity"], ["meal", "Meal"], ["transfer", "Travel"], ["other", "Other"]];

/** Opens the form in a day's row: a time, the place (suggestions near where they sleep that day), what it is. Adding
 *  keeps the form open for the next stop. */
export function openAddStop(root: HTMLElement, di: number) {
  const row = root.querySelector<HTMLElement>(`[data-add-stop="${di}"]`), day = state.itinerary?.days[di];
  if (!row || !day) return;
  row.innerHTML = `<form class="add-stop-form">
      <input type="time" name="time" value="${nextTime(di)}" aria-label="Time">
      <div class="as-place"><input name="place" placeholder="A place, an address, or what you'll do" autocomplete="off" required aria-label="Place"><ul class="bk-suggest" hidden></ul></div>
      <select name="kind" aria-label="What it is">${KINDS.map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select>
      <button class="btn solid">${icon("plus")} Add</button>
      <button type="button" class="icon-btn" data-add-close title="Close" aria-label="Close">${icon("x")}</button>
    </form>`;
  const form = row.querySelector<HTMLFormElement>("form")!, place = form.querySelector<HTMLInputElement>('[name="place"]')!, ul = form.querySelector<HTMLUListElement>("ul")!;
  let hit: GeoHit | null = null, hits: GeoHit[] = [], timer: number | undefined;
  // Near where they sleep that day (or the map's view), in the trip's countries.
  const near = () => { const s = state.stays.find((x) => x.city === day.city); return (s && stayLoc(s)) || map?.getCenter() || { lat: 0, lng: 0 }; };
  place.oninput = () => {
    hit = null; clearTimeout(timer);
    const q = place.value.trim();
    if (q.length < 3) { ul.hidden = true; return; }
    timer = window.setTimeout(async () => {
      const c = near();
      try { hits = await api<GeoHit[]>(`/api/search?${new URLSearchParams({ q, lat: c.lat.toFixed(4), lng: c.lng.toFixed(4), cc: countryCodes(), quick: "1" })}`); } catch { hits = []; }
      if (place.value.trim() !== q) return;
      ul.innerHTML = hits.slice(0, 6).map((r, i) => `<li data-hit="${i}"><b>${esc(r.name)}</b><span>${esc(r.label)}</span></li>`).join("") || `<li class="muted">Not found on the map: it's added by its name.</li>`;
      ul.hidden = false;
    }, 350);
  };
  ul.onmousedown = (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-hit]");
    if (!li) return;
    e.preventDefault();
    hit = hits[+li.dataset.hit!];
    place.value = hit.name;
    ul.hidden = true;
  };
  place.onkeydown = (e) => { if (e.key === "Escape") { if (!ul.hidden) { e.stopPropagation(); ul.hidden = true; } } };
  place.onblur = () => setTimeout(() => { ul.hidden = true; }, 150);
  form.querySelector<HTMLButtonElement>("[data-add-close]")!.onclick = () => { row.outerHTML = addStopHtml(di, !day.items.length); };
  form.onsubmit = (e) => {
    e.preventDefault();
    const name = place.value.trim();
    if (!name) return;
    const time = (form.querySelector<HTMLInputElement>('[name="time"]')!.value || nextTime(di)).slice(0, 5);
    const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!.value as ItineraryItem["kind"];
    addStop(di, { time, place: name, description: "", cost: 0, kind, ...(hit ? { where: hit.label, lat: hit.lat, lng: hit.lng, fixed: true } : {}) });
    // (Not found from a suggestion: looked up by its name, like the plan's other stops.)
    if (!hit) geocodeItems();
    // The plan was drawn again: the form opens again for the next stop.
    const out = $("#output");
    openAddStop(out, di);
    out.querySelector<HTMLInputElement>(`[data-add-stop="${di}"] [name="place"]`)?.focus({ preventScroll: true });
  };
  place.focus();
}
