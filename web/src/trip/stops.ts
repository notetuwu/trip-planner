// "Stops on the way": for a long drive between two stays, ask the server (real road route + the selected model) for
// overnight stops and insert them as stays in between; later stays move back by the added nights. Undo restores.
import { api, esc, toast } from "../core/dom";
import { fmtDate } from "../core/format";
import { type Stay, save, state } from "../core/state";
import { geocodeStays } from "../geo/geocode";
import { stayLoc } from "../geo/locate";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { modelLabel } from "../generate/models";
import { chainDates, renderStays } from "./stays";
import { renderTripTitle } from "./title";

interface StopsResult { km: number; hours: number; stops: { city: string; country?: string; nights: number; why?: string }[]; picked: "model" | "route"; note?: string }

function refresh() { save(); renderStays(); renderTripTitle(); renderItinerary(); geocodeStays(); drawMap({ fit: true }); }

/** The little form under a stay connection: how long to drive a day, then find the stops. */
export function openStopsForm(i: number) {
  const leg = document.querySelector<HTMLElement>(`.stay-leg[data-i="${i}"]`);
  if (!leg || leg.querySelector(".stops-form")) return;
  const form = document.createElement("div");
  form.className = "stops-form";
  form.innerHTML = `Drive up to <select>${[3, 4, 5, 6, 7, 8, 10].map((h) => `<option value="${h}"${h === 6 ? " selected" : ""}>${h} h</option>`).join("")}</select> a day
    <button class="btn solid" type="button" data-go>Find stops</button><button class="btn" type="button" data-cancel>Cancel</button>
    <span class="hint">Uses the real road route, and ${esc(modelLabel(state.model))} picks good towns to stay in.</span>`;
  leg.append(form);
  form.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => form.remove();
  form.querySelector<HTMLButtonElement>("[data-go]")!.onclick = () => findStops(i, +form.querySelector("select")!.value, form);
}

async function findStops(i: number, hoursPerDay: number, form: HTMLElement) {
  const a = state.stays[i - 1], b = state.stays[i], la = stayLoc(a), lb = stayLoc(b);
  if (!la || !lb) return;
  form.innerHTML = `<span class="hint">Finding stops between ${esc(a.city)} and ${esc(b.city)}… (route, then ${esc(modelLabel(state.model))})</span>`;
  let res: StopsResult;
  try {
    res = await api<StopsResult>("/api/stops", { method: "POST", body: JSON.stringify({
      from: { city: a.city, lat: la.lat, lng: la.lng }, to: { city: b.city, lat: lb.lat, lng: lb.lng },
      hoursPerDay, mode: b.travel || "car", model: state.model, travelers: state.travelers, interests: state.interests,
    }) });
  } catch (e) {
    form.innerHTML = `<span class="hint">${esc((e as Error).message)}</span>`;
    return;
  }
  if (!res.stops.length) { form.innerHTML = `<span class="hint">${esc(res.note || "No stops needed.")}</span>`; return; }

  const before: Stay[] = JSON.parse(JSON.stringify(state.stays));
  const added: Stay[] = res.stops.map((s) => ({ city: s.country ? `${s.city}, ${s.country}` : s.city, start: "", nights: s.nights, hotel: "", travel: b.travel || "car" }));
  state.stays.splice(i, 0, ...added);
  // The destination now comes after the stops, so its date follows them again (and so do the stays after it).
  state.stays[i + added.length].manualStart = false;
  chainDates();
  refresh();
  const nights = added.reduce((n, s) => n + s.nights, 0), dest = state.stays[i + added.length];
  toast(`Added ${added.length} stop${added.length > 1 ? "s" : ""} (${nights} night${nights > 1 ? "s" : ""}, ${Math.round(res.km).toLocaleString()} km); ${dest.city} now starts ${fmtDate(dest.start)}`,
    () => { state.stays = before; refresh(); });
  if (res.note) setTimeout(() => toast(res.note!), 8500);
}
