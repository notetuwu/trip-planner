// The stays editor: one card per stay, the transport between them, and day trips.
import type { TravelMode } from "../../../shared/types";
import { $, $$, esc } from "../core/dom";
import { addDays, fmtDate } from "../core/format";
import { type Stay, save, state } from "../core/state";
import { geo, geoKey, geocodeStays } from "../geo/geocode";
import { stayLoc } from "../geo/locate";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { modeOptions } from "./modes";
import { renderTripTitle } from "./title";
import { icon } from "../core/icons";

/** Each stay after the first starts where the previous one ends, unless the user overrides it. */
function chainDates() {
  for (let i = 1; i < state.stays.length; i++) {
    const prev = state.stays[i - 1];
    if (prev.start && !state.stays[i].manualStart) state.stays[i].start = addDays(prev.start, prev.nights);
  }
}

/** The connector between two stay cards: "Padua → Milan  [🚗 Car]". */
function legHtml(i: number) {
  const a = state.stays[i - 1], b = state.stays[i];
  return `<div class="stay-leg" data-i="${i}">
    <span class="leg-text">${esc(a.city || `Stay ${i}`)} → ${esc(b.city || `Stay ${i + 1}`)}</span>
    <select data-k="travel" title="How you get from ${esc(a.city || "the previous stay")} to ${esc(b.city || "this stay")}">${modeOptions(b.travel)}</select>
  </div>`;
}

function stayHtml(s: Stay, i: number) {
  const loc = stayLoc(s);
  const geoLine = !s.city ? "" : loc ? `${icon("pin")} ${esc(loc.label)}` : geoKey(s.city) in geo ? `${icon("pin")} Not found — try a bigger nearby town` : `${icon("pin")} Locating…`;
  return `${i ? legHtml(i) : ""}
    <div class="stay" data-i="${i}">
      <div class="stay-head">
        <span><span class="stay-num">${i + 1}</span><span class="stay-dates">${s.start ? `${fmtDate(s.start)} → ${fmtDate(addDays(s.start, s.nights))}` : "Set an arrival date"}</span></span>
        <span>
          ${i > 0 ? `<button class="icon-btn" data-act="up" title="Move up">${icon("arrowUp")}</button>` : ""}
          ${state.stays.length > 1 ? `<button class="icon-btn" data-act="del" title="Remove">${icon("x")}</button>` : ""}
        </span>
      </div>
      <div class="row">
        <div><label>City / area</label><input data-k="city" value="${esc(s.city)}" placeholder="e.g. Lisbon"></div>
        <div><label>Hotel (optional)</label><input data-k="hotel" value="${esc(s.hotel)}" placeholder="Hotel or address"></div>
      </div>
      <div class="row">
        <div><label>Arrival</label><input type="date" data-k="start" value="${esc(s.start)}"></div>
        <div><label>Nights</label><input type="number" min="0" data-k="nights" value="${esc(s.nights)}"></div>
      </div>
      ${geoLine ? `<div class="stay-geo" title="${esc(loc?.label || "")}">${geoLine}</div>` : ""}
      <div class="day-trips">
        ${(s.dayTrips || []).map((t, ti) => `
          <div class="day-trip" data-ti="${ti}">
            <span class="dt-label">${icon("dayTrip")} Day trip</span>
            <input data-dt="place" value="${esc(t.place)}" placeholder="e.g. Venice">
            <select data-dt="mode" title="How you get there and back">${modeOptions(t.mode)}</select>
            <button class="icon-btn" data-act="deltrip" title="Remove day trip">${icon("x")}</button>
          </div>`).join("")}
        <button class="link-btn" data-act="addtrip">＋ Day trip${s.nights < 2 ? ` <span class="muted">(needs a full day, so 2+ nights)</span>` : ""}</button>
      </div>
    </div>`;
}

export function renderStays() {
  chainDates();
  // Don't rebuild under the user's cursor; it re-renders on change.
  const ae = document.activeElement as HTMLElement | null;
  if (ae?.closest(".stay") && (ae.dataset.k || ae.dataset.dt) && ae.tagName === "INPUT") return;
  $("#stays").innerHTML = state.stays.map(stayHtml).join("");
}

function onChange(e: Event) {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const box = el.closest<HTMLElement>(".stay, .stay-leg"); if (!box) return;
  const stay = state.stays[+box.dataset.i!], k = el.dataset.k, dt = el.dataset.dt;
  if (dt) {
    const t = stay.dayTrips![+el.closest<HTMLElement>(".day-trip")!.dataset.ti!];
    if (dt === "mode") t.mode = el.value as TravelMode; else t.place = el.value.trim();
    if (dt === "place" && t.place) geocodeStays();
    el.blur();
    save(); renderStays(); drawMap(); renderItinerary();
    return;
  }
  if (!k) return;
  if (k === "nights") stay.nights = Math.max(0, +el.value);
  else if (k === "travel") stay.travel = el.value as TravelMode;
  else if (k === "city" || k === "hotel" || k === "start") stay[k] = el.value;
  if (k === "start" && box.dataset.i !== "0") stay.manualStart = true;
  el.blur();
  save(); renderStays(); renderTripTitle(); renderItinerary(); geocodeStays(); drawMap({ fit: true });
}

function onClick(e: Event) {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!btn) return;
  const act = btn.dataset.act;
  const i = +btn.closest<HTMLElement>(".stay")!.dataset.i!;
  if (act === "addtrip") {
    (state.stays[i].dayTrips ||= []).push({ place: "", mode: "" });
    save(); renderStays();
    $$<HTMLInputElement>(`.stay[data-i="${i}"] .day-trip input`).at(-1)?.focus();
    return;
  }
  if (act === "deltrip") {
    state.stays[i].dayTrips!.splice(+btn.closest<HTMLElement>(".day-trip")!.dataset.ti!, 1);
    save(); renderStays(); drawMap(); renderItinerary();
    return;
  }
  if (act === "del") state.stays.splice(i, 1);
  if (act === "up") [state.stays[i - 1], state.stays[i]] = [state.stays[i], state.stays[i - 1]];
  save(); renderStays(); renderTripTitle(); drawMap({ fit: true });
}

export function initStays() {
  $("#stays").addEventListener("change", onChange);
  $("#stays").addEventListener("click", onClick);
  $("#addStay").onclick = () => { state.stays.push({ city: "", start: "", nights: 2, hotel: "" }); save(); renderStays(); };
}
