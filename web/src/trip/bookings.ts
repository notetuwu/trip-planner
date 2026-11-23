// Things already booked (a concert, an expo, a theme park, a timed entry): name, date (or the days a ticket is valid
// for), an optional time or time window, where it is (an address with suggestions, or picked on the map) and cost. The
// planner plans around them, and they always end up on their day (see server/ai/output.ts).
import type { Booking, GeoHit } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { fmtShort, fmtTime, money } from "../core/format";
import { save, state } from "../core/state";
import { icon } from "../core/icons";
import { renderItinerary } from "../itinerary/render";
import { countryCodes, stayLoc, tripCountries } from "../geo/locate";
import { map, pickOnMap } from "../map/map";
import { drawMap } from "../map/draw";

/** Which booking's editor is open (a new one opens by itself). */
let openRow = -1;

/** One line per booking ("teamLab Borderless · 14 Nov 10:30 · €120"), opening into its editor. */
function renderLine(b: Booking) {
  const days = b.date ? (b.until && b.until > b.date ? `${fmtShort(b.date)}–${fmtShort(b.until)}` : fmtShort(b.date)) : "";
  const when = [days, b.from ? `${fmtTime(b.from)}${b.to ? `–${fmtTime(b.to)}` : ""}` : ""].filter(Boolean).join(" ");
  const cost = b.cost != null ? `${money(b.cost, state.currency)}${b.countCost ? "" : " paid"}` : "";
  return `${icon("ticket")}<b>${esc(b.name || "New booking")}</b><span class="bk-when">${esc([when, cost].filter(Boolean).join(" · "))}</span>`;
}

/** A well-known thing people book ahead in one of the trip's countries, as the name field's example. */
const EXAMPLES: Record<string, string> = {
  JP: "teamLab Borderless", DE: "Schloss Neuschwanstein", AT: "Schönbrunn Palace", CH: "Jungfraujoch", IT: "The Last Supper",
  FR: "Eiffel Tower summit", ES: "Sagrada Família", GB: "Tower of London", NL: "Anne Frank House", CZ: "Prague Castle",
  PT: "Pena Palace", GR: "Acropolis", BE: "Atomium", DK: "Tivoli Gardens", HU: "Hungarian Parliament", PL: "Wieliczka Salt Mine",
  HR: "Plitvice Lakes", IE: "Guinness Storehouse", NO: "Flåm Railway", SE: "Vasa Museum", US: "Statue of Liberty crown",
  KR: "Gyeongbokgung hanbok tour", TH: "Grand Palace", CN: "Forbidden City", AU: "Sydney Opera House tour", LI: "Vaduz Castle tour",
};
function exampleBooking() {
  const ccs = tripCountries().map(([cc]) => cc.toUpperCase());
  const cc = ccs.find((c) => EXAMPLES[c]);
  return cc ? EXAMPLES[cc] : "a concert, a museum slot or a guided tour";
}

function rowHtml(b: Booking, i: number) {
  return `
    <details class="booking" data-bi="${i}"${i === openRow ? " open" : ""}>
      <summary>${renderLine(b)}</summary>
      <div class="bk-top">
        <input data-bk="name" value="${esc(b.name)}" placeholder="e.g. ${esc(exampleBooking())}">
        <button class="icon-btn" data-bk-del title="Remove booking">${icon("trash")}</button>
      </div>
      <div class="bk-opts bk-days">
        <input type="date" data-bk="date" value="${esc(b.date)}" title="The day (or the first day the ticket is valid)">
        <span class="muted">to</span>
        <input type="date" data-bk="until" value="${esc(b.until || "")}" min="${esc(b.date)}" title="Valid until (optional): for a ticket valid on several days, the planner picks the best one">
      </div>
      <div class="bk-opts">
        <input type="time" data-bk="from" value="${esc(b.from || "")}" title="From (leave empty if any time that day)">
        <span class="muted">–</span>
        <input type="time" data-bk="to" value="${esc(b.to || "")}" title="Until (optional)">
      </div>
      <div class="bk-where">
        <div class="bk-opts">
          <input data-bk="where" value="${esc(b.where || "")}" placeholder="Where (address or place)" autocomplete="off" title="Where it is: type an address and pick a suggestion, or pick the spot on the map">
          <button type="button" class="icon-btn" data-bk-pick title="Pick the spot on the map" aria-label="Pick the spot on the map">${icon("crosshair")}</button>
        </div>
        <ul class="bk-suggest" hidden></ul>
        ${typeof b.lat === "number" && typeof b.lng === "number" ? `<div class="bk-at hint">${icon("pin")} ${b.lat.toFixed(5)}, ${b.lng.toFixed(5)} <button type="button" class="link-btn" data-bk-unpin>clear</button></div>` : ""}
      </div>
      <div class="bk-opts">
        <input type="number" min="0" step="any" data-bk="cost" value="${b.cost ?? ""}" placeholder="Cost (${esc(state.currency)}, whole group)" title="What it costs the whole group">
        <label class="inline-check" title="Count the cost in that day's budget (off: already paid, shown as 0)"><input type="checkbox" data-bk="countCost"${b.countCost ? " checked" : ""}> in the day's cost</label>
      </div>
    </details>`;
}

export function renderBookings() {
  const list = state.bookings || [];
  // Empty: the same kind of card as "Add places", so it's clear there's something to add here.
  $("#bookings").innerHTML = list.length
    ? list.map(rowHtml).join("") + `<button class="link-btn" type="button" data-bk-add>${icon("plus")} Add a booking</button>`
    : `<button type="button" class="list-empty" data-bk-add>${icon("plus")}<span><b>Add bookings</b><br><span class="hint">Tickets you already have (a concert, an expo, a timed entry): the plan is built around them.</span></span></button>`;
}

/** Address suggestions for a booking's "Where", near the trip (the map's view, else the first stay). */
let suggestTimer: number | undefined, suggestions: GeoHit[] = [];
function suggest(input: HTMLInputElement) {
  clearTimeout(suggestTimer);
  const ul = input.closest(".bk-where")!.querySelector<HTMLUListElement>(".bk-suggest")!;
  const q = input.value.trim();
  if (q.length < 3) { ul.hidden = true; return; }
  suggestTimer = window.setTimeout(async () => {
    const c = map?.getCenter() || stayLoc(state.stays[0]) || { lat: 0, lng: 0 };
    try {
      suggestions = await api<GeoHit[]>(`/api/search?${new URLSearchParams({ q, lat: c.lat.toFixed(4), lng: c.lng.toFixed(4), cc: countryCodes() })}`);
    } catch { suggestions = []; }
    if (input.value.trim() !== q) return;
    ul.innerHTML = suggestions.length ? suggestions.slice(0, 6).map((r, i) => `<li data-sug="${i}"><b>${esc(r.name)}</b><span>${esc(r.label)}</span></li>`).join("")
      : `<li class="muted">Nothing found: try the street and town, or pick the spot on the map.</li>`;
    ul.hidden = false;
  }, 400);
}

/** Where a booking is: kept with it and sent to the planner (its stop in the plan goes on that spot). */
function setWhere(i: number, where: string, at: { lat: number; lng: number } | null) {
  const b = state.bookings![i];
  b.where = where;
  if (at) { b.lat = +at.lat.toFixed(6); b.lng = +at.lng.toFixed(6); } else { delete b.lat; delete b.lng; }
  openRow = i;
  save(); renderBookings(); renderItinerary(); drawMap();
}

export function initBookings() {
  const box = $("#bookings");
  box.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.bk === "where") suggest(el);
  });
  box.addEventListener("keydown", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.bk === "where" && e.key === "Escape") el.closest(".bk-where")!.querySelector<HTMLElement>(".bk-suggest")!.hidden = true;
  });
  box.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement, k = el.dataset.bk as keyof Booking | undefined;
    const row = el.closest<HTMLElement>(".booking");
    if (!k || !row) return;
    const b = state.bookings![+row.dataset.bi!];
    if (k === "countCost") b.countCost = el.checked;
    else if (k === "cost") b.cost = el.value === "" ? undefined : Math.max(0, Number(el.value));
    // Typed by hand: the spot no longer matches (a suggestion or the map sets it again).
    else if (k === "where") { b.where = el.value.trim(); delete b.lat; delete b.lng; }
    else if (k === "until") { if (el.value && el.value > b.date) b.until = el.value; else delete b.until; }
    else (b as unknown as Record<string, string>)[k] = el.value.trim();
    openRow = +row.dataset.bi!;
    save(); renderItinerary();
    // The summary line shows the new values (without closing the editor).
    const line = renderLine(b);
    row.querySelector("summary")!.innerHTML = line;
  });
  box.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-bk-add]")) {
      (state.bookings ||= []).push({ name: "", date: state.stays[0]?.start || "", countCost: true });
      openRow = state.bookings.length - 1;
      save(); renderBookings();
      box.querySelectorAll<HTMLInputElement>('[data-bk="name"]').item((state.bookings.length || 1) - 1)?.focus();
      return;
    }
    const sug = t.closest<HTMLElement>("[data-sug]");
    if (sug) {
      const r = suggestions[+sug.dataset.sug!], i = +sug.closest<HTMLElement>(".booking")!.dataset.bi!;
      if (r) setWhere(i, r.label || r.name, r);
      return;
    }
    const pick = t.closest<HTMLElement>("[data-bk-pick]");
    if (pick) {
      const i = +pick.closest<HTMLElement>(".booking")!.dataset.bi!, b = state.bookings![i];
      pickOnMap(b.name || "the booking", async (at) => {
        const r = await api<{ label?: string; short?: string }>(`/api/reverse?lat=${at.lat}&lng=${at.lng}`).catch(() => null);
        setWhere(i, b.where && b.lat == null ? b.where : r?.short || r?.label || `${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}`, at);
      });
      return;
    }
    if (t.closest("[data-bk-unpin]")) { const i = +t.closest<HTMLElement>(".booking")!.dataset.bi!; setWhere(i, state.bookings![i].where || "", null); return; }
    const del = t.closest<HTMLElement>("[data-bk-del]");
    if (del) { state.bookings!.splice(+del.closest<HTMLElement>(".booking")!.dataset.bi!, 1); openRow = -1; save(); renderBookings(); }
  });
  renderBookings();
}
