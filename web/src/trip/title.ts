// The header: trip name, dates, route and a countdown.
import { $, esc } from "../core/dom";
import { addDays, daysBetween, fmtShort, todayIso } from "../core/format";
import { state } from "../core/state";
import { tripCountries } from "../geo/locate";

export function renderTripTitle() {
  const stays = state.stays.filter((s) => s.city);
  const countries = tripCountries().map(([, name]) => name);
  const name = state.itinerary?.destination || countries.join(" & ") || stays.map((s) => s.city).join(" → ") || "Plan a trip";
  const first = state.stays[0]?.start, last = state.stays.at(-1);
  const end = first && last?.start ? addDays(last.start, last.nights) : "";
  const nights = state.stays.reduce((n, s) => n + (+s.nights || 0), 0);
  const bits = [];
  if (first && end) bits.push(`${fmtShort(first)} – ${fmtShort(end)}`);
  if (nights) bits.push(`${nights} nights`);
  if (stays.length > 1) bits.push(stays.map((s) => s.city).join(" → "));
  bits.push(`${state.travelers} traveler${state.travelers > 1 ? "s" : ""}`);
  let countdown = "";
  if (first && end) {
    const t = todayIso(), until = daysBetween(t, first), since = daysBetween(t, end);
    countdown = until > 0 ? `in ${until} day${until > 1 ? "s" : ""}` : since >= 0 ? `day ${daysBetween(first, t) + 1} of ${daysBetween(first, end) + 1}` : "done";
  }
  $("#tripTitle").innerHTML = `<h1>${esc(name)}</h1><p>${esc(bits.join(" · "))}</p>${countdown ? `<span class="countdown">${esc(countdown)}</span>` : ""}`;
  document.title = name === "Plan a trip" ? "Trip Planner" : `${name} · Trip Planner`;
}
