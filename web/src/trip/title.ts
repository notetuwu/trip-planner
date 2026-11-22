// The header: trip name, dates, route and a countdown.
import { $, esc } from "../core/dom";
import { addDays, daysBetween, fmtShort, todayIso } from "../core/format";
import { state } from "../core/state";
import { tripCountries } from "../geo/locate";

export function renderTripTitle() {
  const stays = state.stays.filter((s) => s.city);
  const countries = tripCountries().map(([, name]) => name);
  // "Germany, Austria, Italy & Switzerland"
  const countryList = countries.length > 1 ? `${countries.slice(0, -1).join(", ")} & ${countries.at(-1)}` : countries[0] || "";
  const name = state.itinerary?.destination || countryList || stays.map((s) => s.city).join(" → ") || "Plan a trip";
  const first = state.stays[0]?.start, last = state.stays.at(-1);
  const end = first && last?.start ? addDays(last.start, last.nights) : "";
  const nights = state.stays.reduce((n, s) => n + (+s.nights || 0), 0);
  const bits = [];
  if (first && end) bits.push(`${fmtShort(first)} – ${fmtShort(end)}`);
  if (nights) bits.push(`${nights} nights`);
  if (stays.length > 1) {
    // A round trip names its start once: "Round trip from Munich: Salzburg → Hallstatt → …".
    // Towns without their country ("Salzburg, Austria" → "Salzburg"): the countries are in the title already.
    const town = (s: { city: string }) => s.city.split(",")[0].trim();
    const [a, z] = [stays[0], stays.at(-1)!], same = stays.length > 2 && a.city.trim().toLowerCase() === z.city.trim().toLowerCase();
    bits.push(same ? `Round trip from ${town(a)}: ${stays.slice(1, -1).map(town).join(" → ")}` : stays.map(town).join(" → "));
  }
  bits.push(`${state.travelers} traveler${state.travelers > 1 ? "s" : ""}`);
  let countdown = "";
  if (first && end) {
    const t = todayIso(), until = daysBetween(t, first), since = daysBetween(t, end);
    countdown = until > 0 ? `in ${until} day${until > 1 ? "s" : ""}` : since >= 0 ? `day ${daysBetween(first, t) + 1} of ${daysBetween(first, end) + 1}` : "done";
  }
  const line = bits.join(" · ");
  $("#tripTitle").innerHTML = `<div class="tt-top"><h1 title="${esc(name)}">${esc(name)}</h1>${countdown ? `<span class="countdown">${esc(countdown)}</span>` : ""}</div>
    <p title="${esc(line)}">${esc(line)}</p>`;
  document.title = name === "Plan a trip" ? "Trip Planner" : `${name} · Trip Planner`;
}
