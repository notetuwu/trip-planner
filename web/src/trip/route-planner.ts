// "Plan a route": describe the trip, get a route of stays from the selected model (each leg checked against the real
// roads), look it over, then use it as the trip's stays (Undo puts the old ones back).
import { $, esc, toast } from "../core/dom";
import { addDays, fmtDate, fmtKm } from "../core/format";
import { icon } from "../core/icons";
import { liveText, streamRequest } from "../core/progress";
import { type Stay, save, session, setListPlaces, state } from "../core/state";
import { renderChips } from "../places/chips";
import { modelLabel } from "../generate/models";
import { geocodeStays } from "../geo/geocode";
import { placeLoc, sameName } from "../geo/locate";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { fillFields } from "./fields";
import { modeName } from "./modes";
import { chainDates, renderStays } from "./stays";
import { renderTripTitle } from "./title";
import { mdLite } from "../itinerary/panels";
import { hideRouteMap, refreshRouteMap, showRouteMap } from "./route-map";
import { searchUrl } from "../core/maps-links";
import type { Place, TravelMode } from "../../../shared/types";

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
  syncModels();
  const n = mustSees().length;
  $("#rpMustRow").hidden = !n;
  $("#rpMustLabel").textContent = `Plan around my must-see places (${n})`;
  const first = state.stays.find((s) => s.city);
  if (!val("rpStart") && first) $<HTMLInputElement>("#rpStart").value = first.city;
  if (!val("rpDate")) $<HTMLInputElement>("#rpDate").value = first?.start || addDays(new Date().toISOString().slice(0, 10), 30);
  $<HTMLDialogElement>("#routeDialog").showModal();
  refreshRouteMap();
}

/** A place of the route in the maps app (opens in a new tab). */
const mapLink = (name: string, country = "", text = name) => {
  const q = country && !name.toLowerCase().includes(country.toLowerCase()) ? `${name}, ${country}` : name;
  return `<a class="rp-link" href="${esc(searchUrl(q))}" data-maps-q="${esc(q)}" target="_blank" rel="noopener" title="Open in your maps app">${esc(text)}</a>`;
};

/** The route's links are made when it's drawn, but follow the maps app chosen in Settings when clicked (the setting may
 *  have changed since, or the route was restored before the settings arrived). */
function followMapsApp(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.rp-link");
  if (!a) return;
  const ll = a.dataset.mapsLl?.split(",").map(Number);
  // By name (the place itself, not a bare pin), near its spot where known.
  a.href = searchUrl(a.dataset.mapsQ || a.textContent || "", ll?.length === 2 ? { lat: ll[0], lng: ll[1] } : null);
}

const viaLines = (l: PlannedLeg) => (l.via || [])
  .map((v) => `<div class="trips">${icon("route")} On the way: <a class="rp-link" href="${esc(searchUrl(v.place, v))}" data-maps-ll="${v.lat},${v.lng}" target="_blank" rel="noopener" title="Open in your maps app">${esc(v.place)}</a>${v.why ? ` · ${esc(v.why)}` : ""}</div>`).join("");

const legLine = (l: PlannedLeg | undefined, travel: string) => (l ? legText(l, travel) + viaLines(l) : "");

const legText = (l: PlannedLeg, travel: string) => {
  const how = travel ? `by ${modeName(travel as TravelMode)}` : "";
  if (l.noRoad) return `<div class="leg long">${icon("warn")} No road found from ${esc(l.from)}; plan another way to get there</div>`;
  if (l.hours == null) return how ? `<div class="leg">${icon("route")} From ${esc(l.from)} ${esc(how)}</div>` : "";
  return `<div class="leg${l.tooLong ? " long" : ""}">${icon(l.tooLong ? "warn" : "route")} ${l.hours} h ${esc(how)} from ${esc(l.from)} (${l.km != null ? fmtKm(l.km) : "?"})${l.tooLong ? " · longer than you wanted" : ""}</div>`;
};

/** Shows a plan on the left; `turn` adds it to the chat as the model's answer (not when restoring a saved one). */
function showPlan(plan: RoutePlan, turn?: Omit<Turn, "route" | "title">) {
  let date = plan.startDate;
  const rows = plan.stays.map((s, k) => {
    const at = date; date = addDays(date, s.nights);
    return `<li><span class="when">${esc(fmtDate(at))}</span><b>${mapLink(s.city, s.country, s.country ? `${s.city}, ${s.country}` : s.city)}</b>
      <span class="nights">${s.nights} night${s.nights > 1 ? "s" : ""}</span>
      ${legLine(plan.legs[k], s.travel)}<div class="why">${esc(s.why)}</div>
      ${(s.dayTrips || []).map((t) => `<div class="trips">${icon("dayTrip")} Day trip: ${mapLink(t.place, s.country)}${t.why ? ` · ${esc(t.why)}` : ""}</div>`).join("")}</li>`;
  }).join("");
  const back = plan.legs.at(-1);
  const long = plan.legs.filter((l) => l.tooLong).length;
  $("#routeResult").innerHTML = `<div class="route-result">
    <h3>${esc(plan.title || "Your route")} <button class="link-btn route-fresh" data-fresh type="button" title="Forget this route and the chat about it">Start over</button></h3><p class="hint">${esc(plan.summary)}</p>
    <div class="route-map" id="rpMap"></div>
    <ul class="route-stops">${rows}
      <li class="end"><span class="when">${esc(fmtDate(date))}</span><b>${mapLink(plan.end, plan.stays.at(-1)?.country || "")}</b><span class="nights">end</span>${legLine(back, plan.stays.at(-1)?.travel || "")}</li></ul>
    ${long ? `<p class="hint">${icon("warn")} ${long} leg${long > 1 ? "s are" : " is"} longer than your daily limit; ask for a change in the chat, or add a night on the way afterwards ("Stops on the way").</p>` : ""}
  </div>`;
  const useBtn = $<HTMLButtonElement>("#rpUse");
  useBtn.hidden = false;
  useBtn.onclick = () => use(plan);
  $<HTMLButtonElement>("#routeResult [data-fresh]").onclick = startOver;
  showRouteMap($("#rpMap"), plan);
  shown = plan;
  if (turn) { chat.push({ route: routeLine(plan), title: plan.title, ...turn }); remember(); $("#routeResult").scrollIntoView({ block: "start", behavior: "smooth" }); }
  renderChat();
  idle();
}

// The plan on screen and the chat about it, kept (also across restarts) until they start over.
const KEY = "trip-planner-route";
const FIELDS = ["rpStart", "rpEnd", "rpDate", "rpDays", "rpHours", "rpMode", "rpWhat", "rpStays"];
const remember = () => {
  const form = Object.fromEntries(FIELDS.map((id) => [id, $<HTMLInputElement>(`#${id}`).value]));
  try { localStorage.setItem(KEY, JSON.stringify({ plan: shown, chat, form })); } catch { /* storage full */ }
};

function startOver() {
  chat.length = 0; shown = null;
  hideRouteMap();
  $("#routeResult").innerHTML = ""; $<HTMLButtonElement>("#rpUse").hidden = true;
  localStorage.removeItem(KEY);
  renderChat(); idle();
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!saved?.plan?.stays) return;
    // What they filled in, so changing the route works after a restart too.
    for (const [id, v] of Object.entries(saved.form || {})) {
      const el = document.querySelector<HTMLInputElement>(`#${id}`);
      if (el && typeof v === "string" && v) el.value = v;
    }
    chat.push(...(Array.isArray(saved.chat) ? saved.chat.filter((t: Turn) => t && typeof t.route === "string") : []));
    showPlan(saved.plan);
    // Saved before the chat existed: the route on screen becomes its first message, so there's something to reply to.
    if (!chat.length) { chat.push({ route: routeLine(saved.plan), title: saved.plan.title, fresh: true }); renderChat(); }
  } catch { /* nothing saved */ }
}

let running: AbortController | null = null;
/** The plan on screen, and the chat: each route suggested (with what the model said about it), then their reply. */
let shown: RoutePlan | null = null;
/** `fresh`: a completely new route ("New route"), where the conversation the model gets starts again. */
interface Turn { route: string; title?: string; note?: string; said?: string; fresh?: boolean; thinking?: string; thoughtSecs?: number }
/** While it plans: its thinking so far (and since when), and what it has written about the route. */
interface Pending { thinking: string; text: string; since: number; until: number }

/** The model's thinking, folded like in the trip chat: "Thinking…" (open, live) or "Thought for 12s". */
const thinkingHtml = (thinking: string, label: string, open: boolean, k = "") =>
  `<details class="cp-think"${open ? " open" : ""}${k ? ` data-k="${k}"` : ""}><summary>${icon("sparkles")}<span>${esc(label)}</span></summary><div class="cp-think-body">${mdLite(thinking)}</div></details>`;
const chat: Turn[] = [];

/** "Salzburg (2 nights; day trips: Hallstatt) → Lucerne (3 nights; on the way there: Vaduz) → …", the route in one line. */
const routeLine = (plan: RoutePlan) => plan.stays.map((s, k) => {
  const extra = [
    s.dayTrips?.length ? `day trips: ${s.dayTrips.map((t) => t.place).join(", ")}` : "",
    plan.legs[k]?.via?.length ? `on the way there: ${plan.legs[k].via!.map((v) => v.place).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `${s.city} (${s.nights} night${s.nights > 1 ? "s" : ""}${extra ? `; ${extra}` : ""})`;
}).join(" → ") + (plan.legs.at(-1)?.via?.length && plan.legs.length > plan.stays.length ? ` → home (on the way: ${plan.legs.at(-1)!.via!.map((v) => v.place).join(", ")})` : "");

/** The chat column; `pending` is the model's answer while it's being written (its thinking and reasoning so far). */
function renderChat(pending?: Pending) {
  const log = $("#rpChat");
  // An opened "Thought for…" stays open across redraws; they keep their place unless they were at the bottom.
  const opened = new Set([...log.querySelectorAll<HTMLDetailsElement>("details.cp-think[data-k]")].filter((d) => d.open).map((d) => d.dataset.k));
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40, top = log.scrollTop;
  const msgs = chat.map((t, k) => `
    ${t.fresh && k > 0 ? `<div class="rc-new">New route</div>` : ""}
    <div class="rc-msg ai">${t.thinking ? thinkingHtml(t.thinking, `Thought for ${t.thoughtSecs || 1}s`, opened.has(String(k)), String(k)) : ""}${t.note ? mdLite(t.note) : ""}<div class="rc-card">${icon("route")}<span><b>${esc(t.title || `Route ${k + 1}`)}</b><span class="rc-route">${esc(t.route)}</span></span></div></div>
    ${t.said ? `<div class="rc-msg me">${esc(t.said)}</div>` : ""}`).join("");
  const answering = !!pending?.text;
  const secs = pending ? Math.max(1, Math.round(((pending.until || Date.now()) - pending.since) / 1000)) : 0;
  log.innerHTML = msgs + (pending ? `<div class="rc-msg ai pending">${pending.thinking ? thinkingHtml(pending.thinking, answering ? `Thought for ${secs}s` : "Thinking…", !answering) : ""}${pending.text
    ? mdLite(pending.text) : !pending.thinking ? `<span class="typing"><i></i><i></i><i></i></span>` : ""}</div>` : "")
    || `<div class="cp-empty"><div class="cp-empty-icon">${icon("route")}</div><p><b>Shape the route here</b></p><p class="hint">Plan a route on the left, then tell it what to change ("the other way round", "Hallstatt as a day trip", "one more night in Lucerne"). It changes that route and keeps the rest; "New route" starts from scratch.</p></div>`;
  log.scrollTop = atEnd || !pending ? log.scrollHeight : top;
  // The live thinking follows its newest line.
  const live = log.querySelector<HTMLElement>(".pending .cp-think[open] .cp-think-body");
  if (live) live.scrollTop = live.scrollHeight;
}

/** The route chat's model menu: "Same as planning (…)" and every model the planning menu has (not its actions). */
function syncModels() {
  const pick = $<HTMLSelectElement>("#rpModel"), main = $<HTMLSelectElement>("#model");
  const opts = [...main.options].filter((o) => o.value && !o.value.startsWith("__"));
  const planning = main.selectedOptions[0]?.textContent?.trim() || "the planning model";
  const html = `<option value="">Same as planning (${esc(planning)})</option>` + opts.map((o) => `<option value="${esc(o.value)}">${esc(o.textContent?.trim() || o.value)}</option>`).join("");
  if (pick.dataset.html !== html) { pick.innerHTML = html; pick.dataset.html = html; }
  pick.value = state.routeModel && opts.some((o) => o.value === state.routeModel) ? state.routeModel : "";
}

/** The model that plans routes: the one picked in the route chat, else the planning model. */
const routeModel = () => (state.routeModel && [...$<HTMLSelectElement>("#model").options].some((o) => o.value === state.routeModel) ? state.routeModel : state.model);

/** Buttons and the chat box for what can be done now. */
function idle() {
  const busy = !!running;
  $("#rpGo").textContent = shown ? "New route" : "Plan the route";
  $<HTMLButtonElement>("#rpGo").disabled = busy;
  const why = $<HTMLTextAreaElement>("#rpWhy");
  why.disabled = busy || !shown;
  // While it plans, the send button is a stop button (like Claude Code's), for a new route as well as a change.
  const sendBtn = $<HTMLButtonElement>("#rpSend");
  if (sendBtn.classList.contains("stop") !== busy) {
    sendBtn.classList.toggle("stop", busy);
    sendBtn.innerHTML = icon(busy ? "stop" : "arrowUp");
    sendBtn.title = busy ? "Stop planning" : "Send (Enter) · new line with Shift+Enter";
  }
  sendBtn.disabled = !busy && (!shown || !why.value.trim());
  $<HTMLSelectElement>("#rpModel").disabled = busy;
  syncModels();
}

/** The reply box grows with what's typed, up to its maximum height (then it scrolls). */
function fitBox() {
  const why = $<HTMLTextAreaElement>("#rpWhy");
  why.style.height = "auto";
  why.style.height = `${Math.min(why.scrollHeight, 200)}px`;
}

/** A reply in the chat: the route on screen gets changed for it. */
function send() {
  const why = $<HTMLTextAreaElement>("#rpWhy"), text = why.value.trim();
  if (!text || !shown || running) return;
  // The form must be complete to plan (it may have been emptied); say so instead of doing nothing.
  if (!$<HTMLFormElement>("#routeForm").reportValidity()) { $("#rpLive").textContent = "Fill in the form on the left first."; return; }
  if (!chat.length) chat.push({ route: routeLine(shown), title: shown.title, fresh: true });
  chat.at(-1)!.said = text;
  why.value = ""; fitBox();
  plan_(true);
}

/** Plans a route: a new one, or (`change`) the one on screen changed for what they just said in the chat. */
async function plan_(change = false) {
  const form = $<HTMLFormElement>("#routeForm");
  if (!form.reportValidity()) return;
  const live = $("#rpLive");
  // The model is fixed when the request starts: switching models meanwhile doesn't change who's answering.
  const model = routeModel();
  // What the model gets of the chat: from the last new route on, when it's changing the one on screen.
  const from = Math.max(0, chat.map((t) => !!t.fresh).lastIndexOf(true));
  const conversation = change ? chat.slice(from).slice(-40).map(({ route, said }) => ({ route, said })) : [];
  running = new AbortController();
  $<HTMLButtonElement>("#rpUse").hidden = true;
  const before = shown;
  hideRouteMap();
  $("#routeResult").innerHTML = "";
  shown = null;
  idle();
  const pending: Pending = { thinking: "", text: "", since: 0, until: 0 };
  renderChat(pending);
  let reasoning = "";
  try {
    const plan = await streamRequest<RoutePlan>("/api/route-plan", {
      start: val("rpStart"), end: val("rpEnd"), startDate: val("rpDate"), days: +val("rpDays"), mode: val("rpMode"),
      maxHours: +val("rpHours"), description: val("rpWhat"), stays: val("rpStays"),
      travelers: state.travelers, interests: state.interests, model, budget: state.dailyBudget, budgetPer: "person", currency: state.currency,
      conversation,
      mustSee: !$("#rpMustRow").hidden && $<HTMLInputElement>("#rpMust").checked ? mustSees() : [],
    }, (l) => {
      live.textContent = `${modelLabel(model)}: ${liveText(l)}`;
      let changed = false;
      if (l.thinking && l.thinking !== pending.thinking) { pending.since ||= Date.now(); pending.thinking = l.thinking; changed = true; }
      if (l.reasoning && l.reasoning !== reasoning) {
        reasoning = l.reasoning;
        if (pending.thinking && !pending.until) pending.until = Date.now();
        pending.text = reasoning; changed = true;
      }
      if (changed) renderChat(pending);
    }, running.signal);
    live.textContent = "";
    running = null;
    // What it says about the route: its reasoning, without the running list of stays (the route is right above it).
    showPlan(plan, { note: reasoning.split(/\n\nStays so far:/)[0].trim() || undefined, fresh: !change,
      ...(pending.thinking ? { thinking: pending.thinking.slice(-20_000), thoughtSecs: Math.max(1, Math.round(((pending.until || Date.now()) - pending.since) / 1000)) } : {}) });
  } catch (e) {
    live.textContent = running?.signal.aborted ? "Cancelled." : (e as Error).message;
    running = null;
    // Nothing came back: the route stays as it was, and what they said goes back in the box to send again.
    const last = chat.at(-1);
    if (change && last?.said) { $<HTMLTextAreaElement>("#rpWhy").value = last.said; delete last.said; fitBox(); }
    if (before) showPlan(before); else { renderChat(); idle(); }
  }
}

/** A place they starred and marked "on the way" ("Burg Hohenwerfen, Austria" matches "Burg Hohenwerfen"). */
function markedWay(place: string) {
  const n = sameName(place);
  return Object.entries(state.how || {}).some(([title, how]) => how === "way" && state.marks[title] === "must" && sameName(title) === n);
}

/** Replaces the trip's stays with the plan: the start (no night there), the stays, and the end. */
function use(plan: RoutePlan) {
  const before = {
    stays: JSON.parse(JSON.stringify(state.stays)) as Stay[], notes: state.notes, wishes: state.wishes, lastRouteWhat: state.lastRouteWhat,
    customPlaces: [...state.customPlaces], marks: { ...state.marks }, how: { ...(state.how || {}) },
  };
  const lastTravel = plan.stays.at(-1)?.travel || "car";
  state.stays = [
    { city: plan.start, start: plan.startDate, nights: 0, hotel: "" },
    ...plan.stays.map((s): Stay => ({
      city: s.country ? `${s.city}, ${s.country}` : s.city, start: "", nights: s.nights, hotel: "", travel: s.travel,
      ...(s.dayTrips?.some((t) => !markedWay(t.place)) ? { dayTrips: s.dayTrips.filter((t) => !markedWay(t.place)).map((t) => ({ place: t.place, mode: s.travel || "car" })) } : {}),
    })),
    { city: plan.end, start: "", nights: 0, hotel: "", travel: lastTravel },
  ];
  chainDates();
  // What kind of trip and stays they described, and why each stay was picked, go on to the itinerary planner (it only
  // sees the stays otherwise).
  const add = (line: string) => { if (line && !state.notes.includes(line)) state.notes = `${state.notes ? `${state.notes}\n` : ""}${line}`; };
  const what = val("rpWhat"), pref = val("rpStays");
  if (pref) add(`Stays: ${pref}`);
  // What kind of trip they described, and why each stay was picked: "What you want to see" (replacing what an earlier
  // route put there, keeping anything they wrote themselves).
  const why = plan.stays.filter((s) => s.why).map((s) => `${s.city}: ${s.why}`).join("; ");
  const fromRoute = [what, why && `From the route plan: ${why}`].filter(Boolean).join("\n");
  const own = (state.wishes || "").split("\n").filter((l) => !l.startsWith("From the route plan:") && l !== state.lastRouteWhat).join("\n").trim();
  if (fromRoute) { state.wishes = [own, fromRoute].filter(Boolean).join("\n"); state.lastRouteWhat = what; }
  // Sights on the way become must-sees planned as stops on that travel day.
  for (const v of plan.legs.flatMap((l) => l.via || [])) {
    // The same place already in a list or the trip (by name, or within about 1 km: "Burg Hohenwerfen" for
    // "Burg Hohenwerfen, Austria"): mark that one rather than adding a second copy.
    const near = (p: Place) => { const l = placeLoc(p); return !!l && Math.abs(l.lat - v.lat) < 0.01 && Math.abs(l.lng - v.lng) < 0.015; };
    const same = [...session.places, ...state.customPlaces].find((p) => p.title === v.place || near(p));
    const title = same?.title || v.place;
    if (!same) state.customPlaces.push({ title, note: v.why, lat: v.lat, lng: v.lng, custom: true, url: `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}` });
    state.marks[title] = "must";
    (state.how ||= {})[title] = "way";
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
  // The model menu follows the planning menu as models come and go.
  $<HTMLSelectElement>("#rpModel").onchange = (e) => { state.routeModel = (e.target as HTMLSelectElement).value; save(); };
  const main = $<HTMLSelectElement>("#model");
  main.addEventListener("change", syncModels);
  new MutationObserver(syncModels).observe(main, { childList: true });
  syncModels();
  $("#routeResult").addEventListener("click", followMapsApp, true);
  $("#planRoute").onclick = open;
  $<HTMLFormElement>("#routeForm").onsubmit = (e) => { e.preventDefault(); plan_(); };
  $<HTMLFormElement>("#rpChatForm").onsubmit = (e) => { e.preventDefault(); if (running) running.abort(); else send(); };
  const why = $<HTMLTextAreaElement>("#rpWhy");
  // Like a chat: Enter sends, Shift+Enter starts a new line (not while an input method is composing a character).
  why.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
  why.oninput = () => { fitBox(); idle(); };
  // A click anywhere in the box puts the cursor in the text.
  $("#rpBox").onclick = (e) => { const t = e.target as HTMLElement; if (t === e.currentTarget || t.classList.contains("cp-tools-fill")) why.focus(); };
  renderChat(); idle();
  restore();
}
