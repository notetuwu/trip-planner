// "Plan a route": describe the trip, get a route of stays from the selected model (each leg checked against the real
// roads), look it over, then use it as the trip's stays (Undo puts the old ones back).
import { $, esc, toast } from "../core/dom";
import { addDays, fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { liveText, streamRequest } from "../core/progress";
import { type Stay, save, state } from "../core/state";
import { modelLabel } from "../generate/models";
import { geocodeStays } from "../geo/geocode";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { fillFields } from "./fields";
import { modeName } from "./modes";
import { chainDates, renderStays } from "./stays";
import { renderTripTitle } from "./title";
import type { TravelMode } from "../../../shared/types";

interface PlannedStay { city: string; country: string; nights: number; travel: TravelMode; why: string; dayTrips?: { place: string; why: string }[] }
interface PlannedLeg { from: string; to: string; km?: number; hours?: number; tooLong: boolean; noRoad?: boolean }
interface RoutePlan { title: string; summary: string; start: string; end: string; startDate: string; stays: PlannedStay[]; legs: PlannedLeg[]; nights: number }

const val = (id: string) => $<HTMLInputElement>(`#${id}`).value.trim();

function open() {
  const first = state.stays.find((s) => s.city);
  if (!val("rpStart") && first) $<HTMLInputElement>("#rpStart").value = first.city;
  if (!val("rpDate")) $<HTMLInputElement>("#rpDate").value = first?.start || addDays(new Date().toISOString().slice(0, 10), 30);
  $<HTMLDialogElement>("#routeDialog").showModal();
}

const legLine = (l: PlannedLeg | undefined, travel: string) => {
  if (!l) return "";
  const how = travel ? `by ${modeName(travel as TravelMode)}` : "";
  if (l.noRoad) return `<div class="leg long">${icon("warn")} No road found from ${esc(l.from)}; plan another way to get there</div>`;
  if (l.hours == null) return how ? `<div class="leg">${icon("route")} From ${esc(l.from)} ${esc(how)}</div>` : "";
  return `<div class="leg${l.tooLong ? " long" : ""}">${icon(l.tooLong ? "warn" : "route")} ${l.hours} h ${esc(how)} from ${esc(l.from)} (${l.km?.toLocaleString()} km)${l.tooLong ? " · longer than you wanted" : ""}</div>`;
};

function showPlan(plan: RoutePlan) {
  let date = plan.startDate;
  const rows = plan.stays.map((s, k) => {
    const at = date; date = addDays(date, s.nights);
    return `<li><span class="when">${esc(fmtDate(at))}</span><b>${esc(s.city)}${s.country ? `, ${esc(s.country)}` : ""}</b>
      <span class="nights">${s.nights} night${s.nights > 1 ? "s" : ""}</span>
      ${legLine(plan.legs[k], s.travel)}<div class="why">${esc(s.why)}</div>
      ${(s.dayTrips || []).map((t) => `<div class="trips">${icon("dayTrip")} Day trip: ${esc(t.place)}${t.why ? ` · ${esc(t.why)}` : ""}</div>`).join("")}</li>`;
  }).join("");
  const back = plan.legs.at(-1);
  const long = plan.legs.filter((l) => l.tooLong).length;
  $("#routeResult").innerHTML = `<div class="route-result">
    <h3>${esc(plan.title || "Your route")}</h3><p class="hint">${esc(plan.summary)}</p>
    <ul class="route-stops">${rows}
      <li class="end"><span class="when">${esc(fmtDate(date))}</span><b>${esc(plan.end)}</b><span class="nights">end</span>${legLine(back, plan.stays.at(-1)?.travel || "")}</li></ul>
    ${long ? `<p class="hint">${icon("warn")} ${long} leg${long > 1 ? "s are" : " is"} longer than your daily limit; try again, or add a night on the way afterwards ("Stops on the way").</p>` : ""}
  </div>`;
  const useBtn = $<HTMLButtonElement>("#rpUse");
  useBtn.hidden = false;
  useBtn.onclick = () => use(plan);
  $("#rpGo").textContent = "Try again";
  $("#routeResult").scrollIntoView({ block: "start", behavior: "smooth" });
}

let running: AbortController | null = null;

async function plan_() {
  const form = $<HTMLFormElement>("#routeForm");
  if (!form.reportValidity()) return;
  const go = $<HTMLButtonElement>("#rpGo"), live = $("#rpLive");
  // The model is fixed when the request starts: switching models meanwhile doesn't change who's answering.
  const model = state.model;
  const think = $("#rpThink"), cancel = $<HTMLButtonElement>("#rpCancel");
  running = new AbortController();
  cancel.hidden = false;
  cancel.onclick = () => running?.abort();
  think.textContent = "Waiting for the model…";
  go.disabled = true;
  $<HTMLButtonElement>("#rpUse").hidden = true;
  $("#routeResult").innerHTML = "";
  try {
    const plan = await streamRequest<RoutePlan>("/api/route-plan", {
      start: val("rpStart"), end: val("rpEnd"), startDate: val("rpDate"), days: +val("rpDays"), mode: val("rpMode"),
      maxHours: +val("rpHours"), description: val("rpWhat"), stays: val("rpStays"),
      travelers: state.travelers, interests: state.interests, model,
    }, (l) => {
      live.textContent = `${modelLabel(model)}: ${liveText(l)}`;
      if (l.reasoning && think.textContent !== l.reasoning) {
        // Follow the newest text, unless they scrolled up to read.
        const box = think.parentElement!, atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        think.textContent = l.reasoning;
        if (atEnd) box.scrollTop = box.scrollHeight;
      }
    }, running.signal);
    live.textContent = "";
    if (think.textContent === "Waiting for the model…") think.textContent = "This model didn't share its reasoning.";
    showPlan(plan);
  } catch (e) {
    live.textContent = running?.signal.aborted ? "Cancelled." : (e as Error).message;
  } finally { go.disabled = false; cancel.hidden = true; running = null; }
}

/** Replaces the trip's stays with the plan: the start (no night there), the stays, and the end. */
function use(plan: RoutePlan) {
  const before = { stays: JSON.parse(JSON.stringify(state.stays)) as Stay[], notes: state.notes };
  const lastTravel = plan.stays.at(-1)?.travel || "car";
  state.stays = [
    { city: plan.start, start: plan.startDate, nights: 0, hotel: "" },
    ...plan.stays.map((s): Stay => ({
      city: s.country ? `${s.city}, ${s.country}` : s.city, start: "", nights: s.nights, hotel: "", travel: s.travel,
      ...(s.dayTrips?.length ? { dayTrips: s.dayTrips.map((t) => ({ place: t.place, mode: s.travel || "car" })) } : {}),
    })),
    { city: plan.end, start: "", nights: 0, hotel: "", travel: lastTravel },
  ];
  chainDates();
  // What kind of stays they want helps the itinerary planner too.
  const pref = val("rpStays");
  if (pref && !state.notes.includes(pref)) state.notes = `${state.notes ? `${state.notes}\n` : ""}Stays: ${pref}`;
  const refresh = () => { save(); fillFields(); renderStays(); renderTripTitle(); renderItinerary(); geocodeStays(); drawMap({ fit: true }); };
  refresh();
  $<HTMLDialogElement>("#routeDialog").close();
  toast(`Using the route: ${plan.stays.length} stays, ${plan.nights} nights. Generate the itinerary when you're ready.`, () => {
    state.stays = before.stays; state.notes = before.notes; refresh();
  });
}

export function initRoutePlanner() {
  $("#planRoute").onclick = open;
  $<HTMLFormElement>("#routeForm").onsubmit = (e) => { e.preventDefault(); plan_(); };
}
