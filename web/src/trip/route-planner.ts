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

/** Shows a plan on the left; `turn` adds it to the chat as the model's answer (not when restoring a saved one). */
function showPlan(plan: RoutePlan, turn?: Omit<Turn, "route" | "title">) {
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
    <h3>${esc(plan.title || "Your route")} <button class="link-btn route-fresh" data-fresh type="button" title="Forget this route and the chat about it">Start over</button></h3><p class="hint">${esc(plan.summary)}</p>
    <ul class="route-stops">${rows}
      <li class="end"><span class="when">${esc(fmtDate(date))}</span><b>${esc(plan.end)}</b><span class="nights">end</span>${legLine(back, plan.stays.at(-1)?.travel || "")}</li></ul>
    ${long ? `<p class="hint">${icon("warn")} ${long} leg${long > 1 ? "s are" : " is"} longer than your daily limit; ask for a change in the chat, or add a night on the way afterwards ("Stops on the way").</p>` : ""}
  </div>`;
  const useBtn = $<HTMLButtonElement>("#rpUse");
  useBtn.hidden = false;
  useBtn.onclick = () => use(plan);
  $<HTMLButtonElement>("#routeResult [data-fresh]").onclick = startOver;
  shown = plan;
  if (turn) { chat.push({ route: routeLine(plan), title: plan.title, ...turn }); remember(); $("#routeResult").scrollIntoView({ block: "start", behavior: "smooth" }); }
  renderChat();
  idle();
}

// The plan on screen and the chat about it, kept (also across restarts) until they start over.
const KEY = "trip-planner-route";
const remember = () => { try { localStorage.setItem(KEY, JSON.stringify({ plan: shown, chat })); } catch { /* storage full */ } };

function startOver() {
  chat.length = 0; shown = null;
  $("#routeResult").innerHTML = ""; $<HTMLButtonElement>("#rpUse").hidden = true;
  localStorage.removeItem(KEY);
  renderChat(); idle();
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!saved?.plan?.stays) return;
    chat.push(...(Array.isArray(saved.chat) ? saved.chat.filter((t: Turn) => t && typeof t.route === "string") : []));
    showPlan(saved.plan);
  } catch { /* nothing saved */ }
}

let running: AbortController | null = null;
/** The plan on screen, and the chat: each route suggested (with what the model said about it), then their reply. */
let shown: RoutePlan | null = null;
/** `fresh`: a completely new route ("New route"), where the conversation the model gets starts again. */
interface Turn { route: string; title?: string; note?: string; said?: string; fresh?: boolean }
const chat: Turn[] = [];

/** "Salzburg (2 nights; day trips: Hallstatt) → Lucerne (3 nights; on the way there: Vaduz) → …", the route in one line. */
const routeLine = (plan: RoutePlan) => plan.stays.map((s, k) => {
  const extra = [
    s.dayTrips?.length ? `day trips: ${s.dayTrips.map((t) => t.place).join(", ")}` : "",
    plan.legs[k]?.via?.length ? `on the way there: ${plan.legs[k].via!.map((v) => v.place).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `${s.city} (${s.nights} night${s.nights > 1 ? "s" : ""}${extra ? `; ${extra}` : ""})`;
}).join(" → ");

/** The chat column; `pending` is the model's answer while it's being written (its reasoning so far). */
function renderChat(pending?: string) {
  const log = $("#rpChat");
  const msgs = chat.map((t, k) => `
    ${t.fresh && k > 0 ? `<div class="rc-new">New route</div>` : ""}
    <div class="rc-msg ai"><b>${esc(t.title || `Route ${k + 1}`)}</b><div class="rc-route">${esc(t.route)}</div>${t.note ? `<p>${esc(t.note)}</p>` : ""}</div>
    ${t.said ? `<div class="rc-msg me">${esc(t.said)}</div>` : ""}`).join("");
  log.innerHTML = msgs + (pending != null ? `<div class="rc-msg ai pending" id="rpThink">${esc(pending)}</div>` : "")
    || `<p class="hint">Plan a route on the left. Then tell it here what to change, and it changes that route, keeping the rest. "New route" starts again from scratch.</p>`;
  log.scrollTop = log.scrollHeight;
}

/** Buttons and the chat box for what can be done now. */
function idle() {
  const busy = !!running;
  $("#rpGo").textContent = shown ? "New route" : "Plan the route";
  $<HTMLButtonElement>("#rpGo").disabled = busy;
  $<HTMLInputElement>("#rpWhy").disabled = busy || !shown;
  $<HTMLButtonElement>("#rpSend").disabled = busy || !shown;
  $<HTMLButtonElement>("#rpCancel").hidden = !busy;
}

/** A reply in the chat: the route on screen gets changed for it. */
function send() {
  const why = $<HTMLInputElement>("#rpWhy"), text = why.value.trim(), last = chat.at(-1);
  if (!text || !shown || !last || running) return;
  last.said = text;
  why.value = "";
  plan_(true);
}

/** Plans a route: a new one, or (`change`) the one on screen changed for what they just said in the chat. */
async function plan_(change = false) {
  const form = $<HTMLFormElement>("#routeForm");
  if (!form.reportValidity()) return;
  const live = $("#rpLive");
  // The model is fixed when the request starts: switching models meanwhile doesn't change who's answering.
  const model = state.model;
  // What the model gets of the chat: from the last new route on, when it's changing the one on screen.
  const from = Math.max(0, chat.map((t) => !!t.fresh).lastIndexOf(true));
  const conversation = change ? chat.slice(from).slice(-8).map(({ route, said }) => ({ route, said })) : [];
  running = new AbortController();
  $<HTMLButtonElement>("#rpCancel").onclick = () => running?.abort();
  $<HTMLButtonElement>("#rpUse").hidden = true;
  const before = shown;
  $("#routeResult").innerHTML = "";
  shown = null;
  idle();
  renderChat("Waiting for the model…");
  let reasoning = "";
  try {
    const plan = await streamRequest<RoutePlan>("/api/route-plan", {
      start: val("rpStart"), end: val("rpEnd"), startDate: val("rpDate"), days: +val("rpDays"), mode: val("rpMode"),
      maxHours: +val("rpHours"), description: val("rpWhat"), stays: val("rpStays"),
      travelers: state.travelers, interests: state.interests, model, budget: state.dailyBudget, currency: state.currency,
      conversation,
      mustSee: !$("#rpMustRow").hidden && $<HTMLInputElement>("#rpMust").checked ? mustSees() : [],
    }, (l) => {
      live.textContent = `${modelLabel(model)}: ${liveText(l)}`;
      const think = document.querySelector<HTMLElement>("#rpThink");
      if (l.reasoning && think && reasoning !== l.reasoning) {
        reasoning = l.reasoning;
        // Follow the newest text, unless they scrolled up to read.
        const log = $("#rpChat"), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        think.textContent = reasoning;
        if (atEnd) log.scrollTop = log.scrollHeight;
      }
    }, running.signal);
    live.textContent = "";
    running = null;
    // What it says about the route: its reasoning, without the running list of stays (the route is right above it).
    showPlan(plan, { note: reasoning.split(/\n\nStays so far:/)[0].trim() || undefined, fresh: !change });
  } catch (e) {
    live.textContent = running?.signal.aborted ? "Cancelled." : (e as Error).message;
    running = null;
    // Nothing came back: the route stays as it was, and what they said goes back in the box to send again.
    const last = chat.at(-1);
    if (change && last?.said) { $<HTMLInputElement>("#rpWhy").value = last.said; delete last.said; }
    if (before) showPlan(before); else { renderChat(); idle(); }
  }
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
  // The plan and the conversation stay: reopening shows them, so they can carry on from here (or start over).
  $<HTMLDialogElement>("#routeDialog").close();
  toast(`Using the route: ${plan.stays.length} stays, ${plan.nights} nights. Generate the itinerary when you're ready.`, () => {
    Object.assign(state, before); refresh();
  });
}

export function initRoutePlanner() {
  $("#planRoute").onclick = open;
  $<HTMLFormElement>("#routeForm").onsubmit = (e) => { e.preventDefault(); plan_(); };
  $<HTMLFormElement>("#rpChatForm").onsubmit = (e) => { e.preventDefault(); send(); };
  renderChat(); idle();
  restore();
}
