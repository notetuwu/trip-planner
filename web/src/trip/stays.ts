// The stays editor: one card per stay, the transport between them, and day trips.
import type { TravelMode } from "../../../shared/types";
import { $, $$, esc } from "../core/dom";
import { addDays, fmtDate } from "../core/format";
import { type Stay, save, state } from "../core/state";
import { geo, geoKey, geocodeStays } from "../geo/geocode";
import { stayLoc, stayMapsUrl } from "../geo/locate";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { modeOptions, plannedMode } from "./modes";
import { renderTripTitle } from "./title";
import { ext, icon } from "../core/icons";
import { bookableMode, hotelUrl, transportUrl } from "../itinerary/travel-links";
import { openStopsForm } from "./stops";

/** Each stay after the first starts where the previous one ends, unless the user overrides it. */
export function chainDates() {
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
    ${a.city && b.city && bookableMode(b.travel) ? `<a class="leg-link" href="${esc(transportUrl(a.city, b.city))}" target="_blank" rel="noopener" title="Ways to get from ${esc(a.city)} to ${esc(b.city)} on Rome2Rio, with links to book">Compare${ext()}</a>` : ""}
    <select data-k="travel" title="How you get from ${esc(a.city || "the previous stay")} to ${esc(b.city || "this stay")}">${modeOptions(b.travel, plannedMode(a.city, b.city))}</select>
    ${stayLoc(a) && stayLoc(b) && ["car", "bus", "bike", ""].includes(b.travel || "") ? `<button class="link-btn leg-stops" data-stops="${i}" type="button" title="Add overnight stops along the road between ${esc(a.city)} and ${esc(b.city)}">${icon("plus")} Stops on the way</button>` : ""}
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
      ${!geoLine ? "" : loc
        ? `<a class="stay-geo" href="${esc(stayMapsUrl(s))}" target="_blank" rel="noopener" title="${esc(`${loc.label}: open in Google Maps`)}">${geoLine}${ext()}</a>`
        : `<div class="stay-geo">${geoLine}</div>`}
      ${s.city && s.start && Number(s.nights) > 0 ? `<a class="stay-hotels" href="${esc(hotelUrl(s, Number(state.travelers) || 1, loc))}" target="_blank" rel="noopener" title="Hotels for these dates on Booking.com">${icon("bed")} Hotels on Booking.com${ext()}</a>` : ""}
      <div class="day-trips">
        ${(s.dayTrips || []).map((t, ti) => `
          <div class="day-trip" data-ti="${ti}">
            <div class="dt-top">
              <span class="dt-label">${icon("dayTrip")} Day trip</span>
              <input data-dt="place" value="${esc(t.place)}" placeholder="e.g. Venice">
              <button class="icon-btn" data-act="deltrip" title="Remove day trip">${icon("x")}</button>
            </div>
            <div class="dt-opts">
              <select data-dt="mode" title="How you get there and back">${modeOptions(t.mode, plannedMode(s.city, t.place))}</select>
              ${peopleSelect(t.people)}
            </div>
          </div>`).join("")}
        <button class="link-btn" data-act="addtrip">＋ Day trip${s.nights < 2 ? ` <span class="muted">(needs a full day, so 2+ nights)</span>` : ""}</button>
      </div>
    </div>`;
}

/** Who goes on a day trip: everyone, or part of the group (then the others get their own plan that day). */
function peopleSelect(people?: number) {
  const n = Number(state.travelers) || 1;
  if (n < 2) return "";
  const opts = [0, ...Array.from({ length: n - 1 }, (_, k) => k + 1)];
  return `<select data-dt="people" title="How many of you go; the others get their own plan that day">${opts.map((v) =>
    `<option value="${v || ""}"${(people && people < n ? people : 0) === v ? " selected" : ""}>${v ? `${v} of ${n}` : "Everyone"}</option>`).join("")}</select>`;
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
    if (dt === "mode") t.mode = el.value as TravelMode;
    else if (dt === "people") t.people = +el.value || undefined;
    else t.place = el.value.trim();
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
  $("#stays").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-stops]");
    if (b) openStopsForm(+b.dataset.stops!);
  });
  $("#addStay").onclick = () => { state.stays.push({ city: "", start: "", nights: 2, hotel: "" }); save(); renderStays(); };
}

/** Scrolls the stays list to a stay (and the connection into it, for a leg clicked on the map) and flashes them. */
export function focusStay(i: number, leg = false) {
  const stay = document.querySelector<HTMLElement>(`.stay[data-i="${i}"]`);
  const conn = leg ? document.querySelector<HTMLElement>(`.stay-leg[data-i="${i}"]`) : null;
  (conn || stay)?.scrollIntoView({ behavior: "smooth", block: leg ? "start" : "center" });
  for (const el of [conn, stay]) {
    if (!el) continue;
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); // restart the animation
  }
}
