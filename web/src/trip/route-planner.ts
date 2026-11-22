// "Plan a route": describe the trip, get a route of stays from the selected model (each leg checked against the real
// roads), look it over, then use it as the trip's stays (Undo puts the old ones back).
import { $, esc, toast } from "../core/dom";
import { addDays, fmtDate } from "../core/format";
import { icon } from "../core/icons";
import { liveText, streamRequest } from "../core/progress";
import { type Stay, save, session, setListPlaces, state } from "../core/state";
import { renderChips } from "../places/chips";
import { modelLabel } from "../generate/models";
import { geocodeStays } from "../geo/geocode";
import { placeLoc } from "../geo/locate";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { fillFields } from "./fields";
import { modeName } from "./modes";
import { chainDates, renderStays } from "./stays";
import { renderTripTitle } from "./title";
import type { TravelMode } from "../../../shared/types";

interface PlannedStay { city: string; country: string; nights: number; travel: TravelMode; why: string; dayTrips?: { place: string; why: string }[] }
interface WayStop { place: string; why: string; lat: number; lng: number }
interface PlannedLeg { from: string; to: string; km?: number; hours?: number; tooLong: boolean; noRoad?: boolean; via?: WayStop[] }
interface RoutePlan { title: string; summary: string; start: string; end: string; startDate: string; stays: PlannedStay[]; legs: PlannedLeg[]; nights: number }

const val = (id: string) => $<HTMLInputElement>(`#${id}`).value.trim();

/** The starred places, with where they are (when known) and how they want to visit them. */
function mustSees() {
  return session.places.filter((p) => state.marks[p.title] === "must").slice(0, 40).map((p) => {
    const loc = placeLoc(p), how = state.how?.[p.title];
    return { name: p.title, ...(loc ? { lat: +loc.lat.toFixed(3), lng: +loc.lng.toFixed(3) } : {}), ...(how ? { how } : {}) };
  });
}

function open() {
  const n = mustSees().length;
  $("#rpMustRow").hidden = !n;
  $("#rpMustLabel").textContent = `Plan around my must-see places (${n})`;
  const first = state.stays.find((s) => s.city);
  if (!val("rpStart") && first) $<HTMLInputElement>("#rpStart").value = first.city;
  if (!val("rpDate")) $<HTMLInputElement>("#rpDate").value = first?.start || addDays(new Date().toISOString().slice(0, 10), 30);
  $<HTMLDialogElement>("#routeDialog").showModal();
}

const viaLines = (l: PlannedLeg) => (l.via || [])
  .map((v) => `<div class="trips">${icon("route")} On the way: ${esc(v.place)}${v.why ? ` · ${esc(v.why)}` : ""}</div>`).join("");

const legLine = (l: PlannedLeg | undefined, travel: string) => (l ? legText(l, travel) + viaLines(l) : "");

const legText = (l: PlannedLeg, travel: string) => {
  const how = travel ? `by ${modeName(travel as TravelMode)}` : "";
  if (l.noRoad) return `<div class="leg long">${icon("warn")} No road found from ${esc(l.from)}; plan another way to get there</div>`;
  if (l.hours == null) return how ? `<div class="leg">${icon("route")} From ${esc(l.from)} ${esc(how)}</div>` : "";
  return `<div class="leg${l.tooLong ? " long" : ""}">${icon(l.tooLong ? "warn" : "route")} ${l.hours} h ${esc(how)} from ${esc(l.from)} (${l.km?.toLocaleString()} km)${l.tooLong ? " · longer than you wanted" : ""}</div>`;
};

/** Shows a plan; `fresh` when it just came from the model (it's added to the tries), not when restored. */
function showPlan(plan: RoutePlan, fresh = true) {
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
    <h3>${esc(plan.title || "Your route")} <button class="link-btn route-fresh" data-fresh type="button" title="Forget this route, the earlier tries and your reasons">Start over</button></h3><p class="hint">${esc(plan.summary)}</p>
    <ul class="route-stops">${rows}
      <li class="end"><span class="when">${esc(fmtDate(date))}</span><b>${esc(plan.end)}</b><span class="nights">end</span>${legLine(back, plan.stays.at(-1)?.travel || "")}</li></ul>
    ${long ? `<p class="hint">${icon("warn")} ${long} leg${long > 1 ? "s are" : " is"} longer than your daily limit; try again, or add a night on the way afterwards ("Stops on the way").</p>` : ""}
  </div>`;
  const useBtn = $<HTMLButtonElement>("#rpUse");
  useBtn.hidden = false;
  useBtn.onclick = () => use(plan);
  $("#rpGo").textContent = "Try again";
  $<HTMLButtonElement>("#routeResult [data-fresh]").onclick = startOver;
  shown = plan;
  if (fresh) { tries.push(routeLine(plan)); remember(); $("#routeResult").scrollIntoView({ block: "start", behavior: "smooth" }); }
}

// The last plan, the tries before it and the reasons, kept (also across restarts) until they start over.
const KEY = "trip-planner-route";
const remember = () => { try { localStorage.setItem(KEY, JSON.stringify({ plan: shown, tries, reasons })); } catch { /* storage full */ } };

function startOver() {
  tries.length = 0; reasons.length = 0; shown = null;
  renderReasons();
  $("#rpFeedback").hidden = true; $("#rpGo").textContent = "Plan the route"; $("#routeResult").innerHTML = ""; $<HTMLButtonElement>("#rpUse").hidden = true;
  localStorage.removeItem(KEY);
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!saved?.plan?.stays) return;
    tries.push(...(saved.tries || [])); reasons.push(...(saved.reasons || []));
    renderReasons();
    if (reasons.length) $("#rpFeedback").hidden = false;
    showPlan(saved.plan, false);
  } catch { /* nothing saved */ }
}

let running: AbortController | null = null;
/** The plan on screen, the routes suggested so far (for "Try again"), and why they asked for another. */
let shown: RoutePlan | null = null;
const tries: string[] = [];
const reasons: string[] = [];

/** "Salzburg (2 nights) → Hallstatt (3 nights; day trip: Dachstein) → …", for telling the model what it suggested. */
const routeLine = (plan: RoutePlan) => plan.stays.map((s) => `${s.city} (${s.nights} night${s.nights > 1 ? "s" : ""}${
  s.dayTrips?.length ? `; day trips: ${s.dayTrips.map((t) => t.place).join(", ")}` : ""})`).join(" → ");

function renderReasons() {
  $("#rpReasons").innerHTML = reasons.map((r, k) => `<li><span>${esc(r)}</span>
    <button class="icon-btn" type="button" data-k="${k}" title="Remove this reason">${icon("x")}</button></li>`).join("");
  $("#rpReasons").querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.onclick = () => { reasons.splice(+b.dataset.k!, 1); renderReasons(); remember(); }; });
}

/** Try again: the first click asks what should be different; the next one (or Enter) plans again with that. */
function tryAgain() {
  const box = $("#rpFeedback"), why = $<HTMLInputElement>("#rpWhy");
  if (box.hidden) { box.hidden = false; why.focus(); box.scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
  const text = why.value.trim();
  if (text && !reasons.includes(text)) reasons.push(text);
  why.value = "";
  renderReasons();
  plan_();
}

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
  shown = null;
  try {
    const plan = await streamRequest<RoutePlan>("/api/route-plan", {
      start: val("rpStart"), end: val("rpEnd"), startDate: val("rpDate"), days: +val("rpDays"), mode: val("rpMode"),
      maxHours: +val("rpHours"), description: val("rpWhat"), stays: val("rpStays"),
      travelers: state.travelers, interests: state.interests, model, budget: state.dailyBudget, currency: state.currency,
      // Earlier suggestions and what they want different, so another try doesn't repeat them.
      previous: tries.slice(-4), feedback: [...reasons],
      mustSee: !$("#rpMustRow").hidden && $<HTMLInputElement>("#rpMust").checked ? mustSees() : [],
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
  const before = {
    stays: JSON.parse(JSON.stringify(state.stays)) as Stay[], notes: state.notes,
    customPlaces: [...state.customPlaces], marks: { ...state.marks }, how: { ...(state.how || {}) },
  };
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
  // Sights on the way become must-sees planned as stops on that travel day.
  for (const v of plan.legs.flatMap((l) => l.via || [])) {
    if (!session.places.some((p) => p.title === v.place) && !state.customPlaces.some((p) => p.title === v.place)) {
      state.customPlaces.push({ title: v.place, note: v.why, lat: v.lat, lng: v.lng, custom: true, url: `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}` });
    }
    state.marks[v.place] = "must";
    (state.how ||= {})[v.place] = "way";
  }
  const refresh = () => {
    save(); setListPlaces(session.listPlaces); fillFields(); renderStays(); renderTripTitle(); renderChips(); renderItinerary(); geocodeStays(); drawMap({ fit: true });
  };
  refresh();
  // The plan, tries and reasons stay: reopening shows them, so they can try again from here (or start over).
  $<HTMLDialogElement>("#routeDialog").close();
  toast(`Using the route: ${plan.stays.length} stays, ${plan.nights} nights. Generate the itinerary when you're ready.`, () => {
    Object.assign(state, before); refresh();
  });
}

export function initRoutePlanner() {
  $("#planRoute").onclick = open;
  $<HTMLFormElement>("#routeForm").onsubmit = (e) => { e.preventDefault(); if (shown) tryAgain(); else plan_(); };
  $<HTMLInputElement>("#rpWhy").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); tryAgain(); } };
  restore();
}
