// The trip chat: a panel beside the plan (Chat in the header) for questions about the trip on screen and for changes
// to it. Questions are answered by the selected model from the stays, the itinerary, the must-sees and the ideas notes.
// Asked for a change, it says what it will change and offers it: Apply changes the days it touches (or revises the whole
// plan) and the trip's setup (must-sees on the way or from a stay, the stays' day trips). Only the latest message has
// buttons; Undo on it puts back everything applied since the first change of the series. The conversation is kept with
// the trip (and saved with it).
// Also the Ideas & notes box: a scratchpad for the travelers that the chat can read, but that isn't sent with a plan.
// The chat never feeds into generation itself: only an applied change does, as its instruction.
import { moveTo } from "../map/move";
import type { GeoHit, ItineraryItem, LegChoice, MustSeeHow } from "../../../shared/types";
import { stayLoc, stayOn } from "../geo/locate";
import { $, api, esc, toast } from "../core/dom";
import { addDays, fmtDate, todayIso } from "../core/format";
import { icon } from "../core/icons";
import { mapsName, pointUrl, routeUrl } from "../core/maps-links";
import { showPicture } from "../core/lightbox";
import { streamRequest } from "../core/progress";
import { type AppState, type ChatSource, groupBudget, keepPlace, save, session, setListPlaces, state } from "../core/state";
import { distKm, geocodePlaces, sameName } from "../geo/locate";
import { applyHow, renderChips } from "../places/chips";
import { chainDates, renderStays } from "./stays";
import { type Snapshot, impactLine, openReview, snapshot } from "./chat-review";
import { drives, fuelEstimate } from "../itinerary/fuel";
import { planProblems } from "../generate/autofix";
import { packingList } from "../itinerary/packing";
import { bookAheadList } from "../itinerary/book-ahead";
import { byTitleMap, geocodeItems, itemLoc } from "../geo/item-loc";
import { runGeneration } from "../generate/run";
import { mdLite } from "../itinerary/panels";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import * as mapModule from "../map/map";
import { routeKey, routes } from "../map/routes";
import { askConfirm } from "../core/ask";

type ChangeState = "offered" | "applying" | "applied" | "failed" | "skipped" | "undone";
interface TripOps { onTheWay?: string[]; fromStay?: string[]; removeDayTrips?: { stay: string; place: string }[]; addDayTrips?: { stay: string; place: string; mode: string }[]; addPlaces?: { name: string; where: string; must: boolean }[]; removeMust?: string[]; rescaleCosts?: { from: number; to: number; days?: number[]; after?: string } }
/** A small edit made straight away, without re-planning (see server/trip/companion.ts). */
interface StopOp { op: "add" | "remove" | "time"; day: number; place: string; time?: string; description?: string; where?: string; cost?: number; kind?: ItineraryItem["kind"]; lat?: number; lng?: number }
/** Anything else they can change by hand (see EDITS_DOC in server/trip/companion.ts). */
interface EditOp { op: string; [k: string]: string | number | boolean | undefined }
interface PlanChange { days: number[]; request: string; trip?: TripOps; stops?: StopOp[]; edits?: EditOp[]; title?: string; status?: ChangeState; skip?: string[]; impact?: string }
type Source = ChatSource;
type Turn = { role: "me" | "ai"; text: string; modelName?: string; images?: string[]; thinking?: string; thoughtSecs?: number; change?: PlanChange; sources?: Source[]; ask?: Ask };
/** A question the chat asked, with answers to pick from, and what they answered (once they have). */
type Ask = { q: string; options: string[]; multi?: boolean; answered?: string };

/** The chat's modes, in the order Shift+Tab goes through them. */
type Mode = "ask" | "manual" | "auto";
const MODES: Record<Mode, { label: string; icon: "chat" | "hand" | "zap"; tip: string }> = {
  ask: { label: "Ask", icon: "chat", tip: "Answers and looks things up, but never changes the trip." },
  manual: { label: "Manual", icon: "hand", tip: "Offers changes; every one waits for you to press Apply." },
  auto: { label: "Auto", icon: "zap", tip: "Small edits that don't re-plan (a stop, a time, your places) happen by themselves, with Undo. Bigger changes still wait for Apply." },
};
const ORDER: Mode[] = ["ask", "manual", "auto"];
const mode = (): Mode => state.chatMode || "manual";
/** The mode button (icon and name) and, while open, the menu above it: each mode with its icon, name and what it does. */
let dropModeListeners = () => {};
function renderMode(open = false) {
  dropModeListeners();
  dropModeListeners = () => {};
  const b = document.querySelector<HTMLButtonElement>("#cpMode");
  if (!b) return;
  const m = MODES[mode()];
  b.innerHTML = `${icon(m.icon)}<span>${m.label}</span>`;
  b.title = `${m.label} mode: ${m.tip} Shift+Tab switches.`;
  b.dataset.mode = mode();
  b.setAttribute("aria-expanded", String(open));
  document.querySelector("#cpModeMenu")?.remove();
  if (!open) return;
  const menu = document.createElement("div");
  menu.id = "cpModeMenu";
  menu.className = "cp-mode-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<div class="cp-mode-head">Mode <span class="muted">Shift+Tab to switch</span></div>${ORDER.map((k) => `<button type="button" role="menuitemradio" aria-checked="${k === mode()}" class="cp-mode-item${k === mode() ? " on" : ""}" data-mode-pick="${k}" data-mode="${k}">
      ${icon(MODES[k].icon)}<span><b>${MODES[k].label}</b><small>${MODES[k].tip}</small></span>${k === mode() ? icon("check", "cp-mode-on") : ""}</button>`).join("")}`;
  b.parentElement!.appendChild(menu);
  menu.querySelectorAll<HTMLButtonElement>("[data-mode-pick]").forEach((x) => { x.onclick = () => setMode(x.dataset.modePick as Mode); });
  // Closes on a click anywhere else, or Escape.
  const close = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.contains(e.target as Node) && !b.contains(e.target as Node)) renderMode(false);
  };
  document.addEventListener("pointerdown", close, true);
  document.addEventListener("keydown", close, true);
  dropModeListeners = () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", close, true); };
}
function setMode(m: Mode) { state.chatMode = m; save(); renderMode(false); }
function nextMode() { setMode(ORDER[(ORDER.indexOf(mode()) + 1) % ORDER.length]); }
/** Small enough for Auto mode to make by itself: no re-planning, at most a few stop edits, nothing taken off the trip's
 *  day trips. */
const SMALL_EDITS = ["note", "idea", "booked", "packed", "packAdd", "packRemove", "setCost", "must", "skip"];
const small = (c: PlanChange) => !c.request && (c.stops?.length || 0) + (c.edits?.length || 0) <= 3 && !c.trip?.removeDayTrips?.length && !c.trip?.addDayTrips?.length && !c.trip?.rescaleCosts
  && (c.edits || []).every((e) => SMALL_EDITS.includes(e.op));

/** One edit in words. */
function editLine(e: EditOp) {
  const v = (x: unknown) => String(x ?? "");
  switch (e.op) {
    case "set": return `${v(e.field)}: ${v(e.value) || "(none)"}`;
    case "stayNights": return `${v(e.stay)}: ${v(e.nights)} night${Number(e.nights) === 1 ? "" : "s"}`;
    case "stayHotel": return `${v(e.stay)}: staying at ${v(e.value)}`;
    case "stayTravel": return `${v(e.stay)}: getting there by ${v(e.value)}`;
    case "transport": return `Day ${v(e.day)}, ${v(e.place)}: ${v(e.value) || `by ${v(e.mode)}`}`;
    case "addStay": return `New stay: ${v(e.city)}, ${v(e.nights) || 1} night(s)${e.after ? `, after ${v(e.after)}` : ""}`;
    case "removeStay": return `Remove the stay in ${v(e.stay)}`;
    case "moveStop": return `${v(e.place)}: day ${v(e.day)} → day ${v(e.toDay)}${e.time ? ` at ${v(e.time)}` : ""}`;
    case "swapDays": return `Swap days ${v(e.day)} and ${v(e.toDay)}`;
    case "setCost": return `Day ${v(e.day)}, ${v(e.place)}: costs ${v(e.value)} ${state.currency}`;
    case "addBooking": return `Booked: ${v(e.name)} on ${v(e.date)}${e.from ? ` ${v(e.from)}${e.to ? `-${v(e.to)}` : ""}` : ""}`;
    case "removeBooking": return `Remove the booking ${v(e.name)}`;
    case "booked": return `Book ahead: ${v(e.item || `day ${v(e.day)}, ${v(e.place)}`)} ${e.done === false ? "not booked yet" : "ticked off as booked"}`;
    case "packed": return `Packing: ${v(e.item)} ${e.done === false ? "not packed yet" : "packed"}`;
    case "packAdd": return `Packing list: add ${v(e.value)}`;
    case "packRemove": return `Packing list: remove ${v(e.value)}`;
    case "must": return `${v(e.place)}: must-see`;
    case "skip": return `${v(e.place)}: skip it`;
    case "setCar": return `Car: ${v(e.fuel) || "none"}${e.per100 ? `, ${v(e.per100)} per 100 km` : ""}`;
    case "note": return `Remember in your notes: ${v(e.value)}`;
    case "idea": return `Add to ideas & notes: ${v(e.value)}`;
    default: return e.op;
  }
}

const PACE: Record<string, string> = { relaxed: "relaxed (2-3 main stops per day, late starts)", balanced: "balanced (3-5 stops per day)", packed: "packed (as much as possible, early starts)" };
/** Makes the edits in the trip itself, without the planner. */
function applyEdits(edits: EditOp[]) {
  const it = state.itinerary;
  const stayOf = (name: unknown) => state.stays.find((s) => s.city && sameStay(s.city, String(name || "")));
  const dayAt = (n: unknown) => it?.days[Number(n) - 1];
  const sumDay = (d: { items: ItineraryItem[]; estimatedCost: number }) => { d.items.sort((a, b) => (a.time && b.time ? a.time.localeCompare(b.time) : 0)); d.estimatedCost = d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0); };
  for (const e of edits) {
    const s = String(e.value ?? "");
    if (e.op === "set") {
      const f = String(e.field);
      if (f === "travelers" && Number(e.value) >= 1) state.travelers = Math.min(30, Math.round(Number(e.value)));
      else if (f === "dailyBudget" && Number(e.value) >= 0) { state.dailyBudget = Math.round(Number(e.value)); state.budgetPer = "person"; }
      else if (f === "currency" && /^[A-Z]{3}$/i.test(s)) state.currency = s.toUpperCase();
      else if (f === "pace" && PACE[s]) state.pace = PACE[s];
      else if (f === "fitness" && ["easy", "average", "fit"].includes(s)) state.fitness = s as never;
      else if (f === "dayStart" && (s === "" || /^\d{2}:\d{2}$/.test(s))) state.dayStart = s;
      else if (f === "breakfast" && ["", "hotel", "out", "brunch", "skip"].includes(s)) state.breakfast = s as never;
      else if (f === "getAround" && ["", "transit", "car"].includes(s)) state.getAround = s as never;
      else if (f === "interests") state.interests = s;
      else if (f === "wishes") state.wishes = s;
    } else if (e.op === "stayNights") { const st = stayOf(e.stay); if (st && Number(e.nights) >= 0) { st.nights = Math.round(Number(e.nights)); chainDates(); } }
    else if (e.op === "stayHotel") { const st = stayOf(e.stay); if (st) st.hotel = s; }
    else if (e.op === "stayTravel") { const st = stayOf(e.stay); if (st && ["car", "train", "bus", "walk", "bike", "ferry", "flight"].includes(s)) st.travel = s as never; }
    else if (e.op === "addStay" && e.city) {
      const after = stayOf(e.after), at = after ? state.stays.indexOf(after) + 1 : state.stays.length;
      state.stays.splice(at, 0, { city: String(e.city), start: "", nights: Math.max(0, Math.round(Number(e.nights) || 1)), hotel: "" });
      chainDates();
    } else if (e.op === "removeStay") { const st = stayOf(e.stay); if (st && state.stays.length > 1) { state.stays.splice(state.stays.indexOf(st), 1); chainDates(); } }
    else if (e.op === "transport") {
      // How they get to one stop: its words, and the way the map draws the leg (set like "How you get here" by hand).
      const d = dayAt(e.day), x = d?.items.find((y) => samePlace(y.place, String(e.place)));
      const LEG: Record<string, LegChoice> = { walk: "foot", bike: "bike", car: "car", taxi: "car", bus: "bus", tram: "transit", metro: "transit", train: "train", ferry: "ferry", cablecar: "lift", flight: "flight" };
      if (x) {
        if (s) { x.transport = s; delete x.transportWas; }
        const m = LEG[String(e.mode || "")];
        if (m) x.leg = { modes: [m], via: [] };
      }
    }
    else if (e.op === "moveStop") {
      const from = dayAt(e.day), to = dayAt(e.toDay), i = from ? from.items.findIndex((x) => samePlace(x.place, String(e.place))) : -1;
      if (from && to && i >= 0) { const [x] = from.items.splice(i, 1); if (e.time && /^\d{1,2}:\d{2}$/.test(String(e.time))) x.time = String(e.time).padStart(5, "0"); to.items.push(x); sumDay(from); sumDay(to); }
    } else if (e.op === "swapDays") {
      const a = dayAt(e.day), b = dayAt(e.toDay);
      if (a && b) { for (const k of ["city", "title", "items", "notes", "estimatedCost"] as const) { const t = a[k]; (a as any)[k] = b[k]; (b as any)[k] = t; } }
    } else if (e.op === "setCost") {
      const d = dayAt(e.day), x = d?.items.find((y) => samePlace(y.place, String(e.place)));
      if (d && x && Number(e.value) >= 0) { x.cost = Number(e.value); sumDay(d); }
    } else if (e.op === "addBooking" && e.name && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date))) {
      state.bookings = [...(state.bookings || []), { name: String(e.name), date: String(e.date), ...(e.from ? { from: String(e.from) } : {}), ...(e.to ? { to: String(e.to) } : {}) } as never];
    } else if (e.op === "removeBooking") state.bookings = (state.bookings || []).filter((b) => !samePlace(b.name, String(e.name)));
    else if (e.op === "booked" && it) {
      // By the entry's words in the list, or (older form) by day and stop.
      const list = bookAheadList(it), name = String(e.item || "");
      let key = name ? (list.find((r) => sameName(r.label).startsWith(sameName(name))) || list.find((r) => samePlace(r.label, name)))?.key : undefined;
      if (!key) { const d = dayAt(e.day), x = d?.items.find((y) => samePlace(y.place, String(e.place))); if (d && x) key = `${d.date}|${x.place}`; }
      if (key) { state.booked = { ...(state.booked || {}) }; if (e.done === false) delete state.booked[key]; else state.booked[key] = true; }
    } else if (e.op === "packed" && it) {
      const all = [...packingList(it).flatMap((g) => g.items.map((x) => x.text)), ...(state.packingExtra || [])];
      const name = String(e.item || ""), item = all.find((t) => sameName(t) === sameName(name)) || all.find((t) => samePlace(t, name));
      if (item) { state.packed = { ...(state.packed || {}) }; if (e.done === false) delete state.packed[item]; else state.packed[item] = true; }
    } else if (e.op === "packAdd" && s && !(state.packingExtra || []).some((t) => sameName(t) === sameName(s))) state.packingExtra = [...(state.packingExtra || []), s.slice(0, 80)];
    else if (e.op === "packRemove" && s) {
      const gone = (state.packingExtra || []).find((t) => sameName(t) === sameName(s));
      if (gone) { state.packingExtra = (state.packingExtra || []).filter((t) => t !== gone); if (state.packed) delete state.packed[gone]; }
    }
    else if (e.op === "must" || e.op === "skip") { const title = placeTitle(String(e.place)); state.marks[title] = e.op; }
    else if (e.op === "setCar") state.car = { ...(state.car || { fuel: "", per100: 0 }), fuel: (["petrol", "diesel", "electric"].includes(String(e.fuel)) ? e.fuel : "") as never, ...(Number(e.per100) > 0 ? { per100: Number(e.per100) } : {}) };
    else if (e.op === "note" && s) state.notes = `${state.notes ? `${state.notes.trim()}\n` : ""}${s}`;
    else if (e.op === "idea" && s) state.ideas = `${state.ideas ? `${state.ideas.trim()}\n` : ""}${s}`;
  }
  if (it) it.totalEstimatedCost = it.days.reduce((n, d) => n + (Number(d.estimatedCost) || 0), 0);
}

/** Each part of a change, with a key, so single parts can be left out (the checkboxes on the card). */
function entries(c: PlanChange) {
  const out: { key: string; text: string }[] = [];
  const t = c.trip || {};
  for (const f of ["onTheWay", "fromStay", "removeDayTrips", "addDayTrips", "removeMust", "addPlaces"] as const) {
    ((t[f] || []) as unknown[]).forEach((x, i) => out.push({ key: `t:${f}:${i}`, text: opsLines({ [f]: [x] } as TripOps)[0] }));
  }
  if (t.rescaleCosts) out.push({ key: "t:rescale", text: opsLines({ rescaleCosts: t.rescaleCosts })[0] });
  (c.stops || []).forEach((o, i) => out.push({ key: `s:${i}`, text: stopLines([o])[0] }));
  (c.edits || []).forEach((e, i) => out.push({ key: `e:${i}`, text: editLine(e) }));
  return out;
}
/** The change without the parts they unticked. */
function chosen(c: PlanChange): PlanChange {
  const skip = new Set(c.skip || []);
  if (!skip.size) return c;
  const t: TripOps = {};
  for (const f of ["onTheWay", "fromStay", "removeDayTrips", "addDayTrips", "removeMust", "addPlaces"] as const) {
    const kept = ((c.trip?.[f] || []) as unknown[]).filter((_, i) => !skip.has(`t:${f}:${i}`));
    if (kept.length) (t as any)[f] = kept;
  }
  if (c.trip?.rescaleCosts && !skip.has("t:rescale")) t.rescaleCosts = c.trip.rescaleCosts;
  return { ...c, trip: Object.keys(t).length ? t : undefined, stops: c.stops?.filter((_, i) => !skip.has(`s:${i}`)), edits: c.edits?.filter((_, i) => !skip.has(`e:${i}`)) };
}
/** Whether a change has parts the page makes itself (no planner). */
const direct = (c: PlanChange) => !!(c.trip || c.stops?.length || c.edits?.length);
/** The direct parts made in the trip (no redraw). */
function applyDirect(c: PlanChange) {
  if (c.trip) applyOps(c.trip);
  if (c.stops?.length) applyStops(c.stops);
  if (c.edits?.length) applyEdits(c.edits);
}
/** What the trip would look like with the direct parts made: made, captured, and put back. */
function wouldBe(c: PlanChange): { before: Snapshot; after: Snapshot } {
  const before = capture();
  applyDirect(c);
  const after = capture();
  Object.assign(state, structuredClone(before));
  save(); // whatever was saved while it was made is the trip as it really is
  return { before, after };
}

/** Whether an item's cost is per person (meals, tickets, fares) rather than for the group (the car, parking, fuel). */
export function perPerson(x: ItineraryItem) {
  if (x.costPer) return x.costPer === "person";
  const t = `${x.place} ${x.transport || ""}`;
  if (/\b(car|drive|driving|parking|park|fuel|petrol|diesel|toll|vignette|taxi|uber)\b/i.test(t)) return false;
  if (x.kind === "transfer" || x.kind === "other") return /\b(train|rail|bus|coach|ferry|boat|flight|plane|tram|metro|subway|cable car|funicular|gondola|ticket)\b/i.test(t);
  return x.kind === "meal" || x.kind === "sight" || x.kind === "activity" || !x.kind;
}

/** The plan's costs for another number of travelers: per-person costs scaled, group costs kept, totals added up again. */
export function rescaleCosts(it: NonNullable<AppState["itinerary"]>, from: number, to: number, days?: number[], after?: string) {
  const first = days?.length ? Math.min(...days) : 0;
  it.days.forEach((d, i) => {
    if (days?.length && !days.includes(i + 1)) return;
    // On the day someone joins, only what comes after they're there.
    for (const x of d.items) if (perPerson(x) && Number(x.cost) && !(after && i + 1 === first && x.time && x.time < after)) x.cost = Math.round((Number(x.cost) * to) / from);
    d.estimatedCost = d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0);
  });
  it.totalEstimatedCost = it.days.reduce((n, d) => n + (Number(d.estimatedCost) || 0), 0);
}

/** The pages, places and routes an answer used, as links (routes and places open in their maps app). */
function sourcesHtml(list?: Source[]) {
  if (!list?.length) return "";
  const app = mapsName();
  const dur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
  // Where each one really came from: the web page itself, OpenStreetMap's place search (Nominatim), or the OSRM
  // routing service on OpenStreetMap data. The maps-app link is only for checking it yourself, and says so.
  const osm = (p: { lat: number; lng: number }) => `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(5)}&mlon=${p.lng.toFixed(5)}#map=15/${p.lat.toFixed(5)}/${p.lng.toFixed(5)}`;
  const check = (url: string) => `<a class="cp-check" href="${esc(url)}" target="_blank" rel="noopener">check in ${esc(app)}</a>`;
  const item = (s: Source) => s.kind === "web"
    ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="muted">${esc(new URL(s.url).hostname.replace(/^www\./, ""))}</span>`
    : s.kind === "place"
      ? `<a href="${esc(osm(s))}" target="_blank" rel="noopener">${esc(s.label.split(",").slice(0, 3).join(","))}</a> <span class="muted">OpenStreetMap place search (Nominatim) · ${check(pointUrl(s, s.label.split(",")[0]))}</span>`
      : `${esc(s.stops.map((p) => p.label.split(",")[0]).join(" → "))} <span class="muted">${s.km.toLocaleString()} km, ${dur(s.mins)} driving · OSRM routing on OpenStreetMap data · ${check(routeUrl(s.stops))}</span>`;
  return `<details class="cp-sources"><summary>${icon("globe")} Sources (${list.length})</summary><ol>${list.map((s) => `<li>${item(s)}</li>`).join("")}</ol></details>`;
}
/** Pictures attached to the next message: what's sent (shrunk to at most 1600 px) and a small copy kept with the chat. */
interface Picture { type: string; data: string; thumb: string }
let pictures: Picture[] = [];
/** The full-size picture behind each small copy shown in the chat (only while the page is open). */
const fullSize = new Map<string, string>();

/** While it answers: the answer so far, and its thinking so far (with when it started). */
interface Pending { text: string; thinking: string; since: number; until: number; answering: boolean; status?: string }
/** A short note at the end of the conversation (a summary being written, an error with Retry); not kept with the chat. */
let notice = "";
function setNotice(html: string) { notice = html; render(); }

let running: AbortController | null = null;
/** A change Auto mode applies once the answer is shown (its message index), or -1. */
let autoApply = -1;
/** What a change touches, to put back on Undo. */
/** The changes applied one after another since the last Undo (by message index), and the trip from before the first:
 *  Undo on the latest puts all of them back. Only while the page is open. */
let chain: { snap: Snapshot; cards: number[] } | null = null;
const capture = (): Snapshot => snapshot();

const panel = () => $<HTMLElement>("#chatPanel");
const box = () => $<HTMLTextAreaElement>("#cpQ");
/** Compacting: once the conversation since the summary is this long (tokens, or failing that this many messages), the
 *  older messages are summarized, keeping the most recent few as they are. Until then all of it goes to the model:
 *  a fixed count of 16 messages summarized short chats of a few hundred tokens, and only the last 12 were sent. */
const COMPACT_TOKENS = 12000, COMPACT_MESSAGES = 60, KEEP_RECENT = 6;
/** The next redraw scrolls to the end whatever the position (they just sent something, or opened the chat). */
let jumpToEnd = true;
const OPEN_KEY = "trip-planner-chat-open";

/** Everything the chat knows about the trip, as plain text. Long itineraries lose the descriptions first. */
export function tripContext(full = true): string {
  const s = state, it = s.itinerary, out: string[] = [];
  const stays = s.stays.filter((x) => x.city);
  out.push(`Travelers: ${s.travelers} · budget about ${s.dailyBudget} ${s.currency} per person a day (${s.dailyBudget * Math.max(1, s.travelers)} for the group; day costs in the plan are for the group) · pace: ${s.pace}`);
  // How their days go: the planner plans by these, so the chat should too (and can say when a day doesn't fit them).
  const BREAKFAST: Record<string, string> = { hotel: "at the hotel", out: "out at a café", brunch: "brunch instead", skip: "they skip it" };
  out.push([
    `Days start: ${/^\d{2}:\d{2}$/.test(s.dayStart || "") ? `around ${s.dayStart}` : "any time (not set)"}`,
    s.breakfast ? `breakfast: ${BREAKFAST[s.breakfast] || s.breakfast}` : "",
    s.fitness ? `fitness: ${s.fitness}` : "",
    `getting around: ${s.getAround === "transit" ? "public transport and the odd taxi (no car)" : s.getAround === "car" ? "by car" : "not set (the plan decides)"}`,
  ].filter(Boolean).join(" · "));
  if (s.interests) out.push(`Interests: ${s.interests}`);
  if (s.wishes) out.push(`What they want to see: ${s.wishes}`);
  for (const b of (s.bookings || []).filter((x) => x.name && x.date)) out.push(`Booked: ${b.name} on ${b.date}${b.from ? ` ${b.from}${b.to ? `-${b.to}` : ""}` : ""}`);
  if (s.notes) out.push(`Their notes for the plan: ${s.notes}`);
  if (stays.length) {
    out.push("", "Stays:");
    stays.forEach((x, k) => {
      const trips = (x.dayTrips || []).map((d) => `${d.place} (${[d.mode, d.people ? `${d.people} of ${s.travelers} go` : ""].filter(Boolean).join(", ")})`).join(", ");
      // The routed drive from the previous stay, as the map has it (the same routing service as the chat's lookups).
      const a = k ? stayLoc(stays[k - 1]) : null, b = stayLoc(x);
      const r = a && b && x.travel === "car" ? routes[routeKey("car", [a.lat, a.lng], [b.lat, b.lng])] : null;
      const drive = r ? ` (routed drive from ${stays[k - 1].city}: ${(r.d / 1000).toFixed(1)} km, ${Math.floor(r.t / 3600)} h ${Math.round((r.t % 3600) / 60)} min)` : "";
      out.push(`- ${x.city}: ${x.start ? `${fmtDate(x.start)} (${x.start}) to ${addDays(x.start, x.nights)}, ` : ""}${x.nights} night${x.nights === 1 ? "" : "s"}`
        + `${x.hotel ? `, staying at ${x.hotel}` : ""}${x.travel ? `, getting there by ${x.travel}${drive}` : ""}${trips ? `; day trips: ${trips}` : ""}`);
    });
  }
  const HOW: Record<string, string> = { way: "on the way between stays", stay: "from where they sleep" };
  const must = session.places.filter((p) => s.marks[p.title] === "must").map((p) => `${p.title}${s.how?.[p.title] ? ` (${HOW[s.how[p.title]]})` : ""}`);
  const skip = session.places.filter((p) => s.marks[p.title] === "skip").map((p) => p.title);
  if (must.length) out.push("", `Must-see places: ${must.join("; ")}`);
  if (skip.length) out.push(`Places they don't want: ${skip.join("; ")}`);
  if (s.ideas?.trim()) out.push("", "Their ideas & notes (brainstorming):", s.ideas.trim());
  if (it?.days?.length) {
    out.push("", `Itinerary${it.destination ? ` (${it.destination})` : ""}: ${it.summary || ""}`);
    if (s.meta?.travelers) out.push(`The plan's costs are for ${s.meta.travelers} traveler${s.meta.travelers > 1 ? "s" : ""}${s.meta.travelers !== s.travelers ? ` (the trip now has ${s.travelers}: offer to work the costs out again)` : ""}.`);
    it.days.forEach((d, k) => {
      out.push(`\nDay ${k + 1} · ${fmtDate(d.date)} (${d.date}) · ${d.city} · ${d.title}${d.estimatedCost ? ` · about ${d.estimatedCost} ${s.currency}` : ""}`);
      for (const i of d.items) {
        const extra = [i.cost ? `${i.cost} ${s.currency}` : "", i.booking ? `booking ${i.booking}` : "", i.transport || ""].filter(Boolean).join(", ");
        out.push(`- ${i.time} ${i.place}${extra ? ` [${extra}]` : ""}${full && i.description ? `: ${i.description}` : ""}`);
      }
      if (d.notes) out.push(`  Notes: ${d.notes}`);
    });
    if (it.holidaysAndEvents?.length) out.push("", "Holidays and events:", ...it.holidaysAndEvents.map((h) => `- ${h.date}${h.where ? ` (${h.where})` : ""}: ${h.name}: ${h.impact}`));
    if (it.tips?.length) out.push("", "Tips in the plan:", ...it.tips.map((t) => `- ${t}`));
    const booked = Object.entries(s.booked || {}).filter(([, v]) => v).map(([k]) => k.split("|").reverse().join(" on "));
    if (booked.length) out.push("", `Already booked: ${booked.join("; ")}`);
  } else out.push("", "No itinerary generated yet.");
  const text = out.join("\n");
  return full && text.length > 50_000 ? tripContext(false) : text;
}

const chat = (): Turn[] => state.chat || [];
const dayList = (days: number[]) => days.length === 1 ? `day ${days[0]}` : days.length ? `days ${days.slice(0, -1).join(", ")} and ${days.at(-1)}` : "the whole plan";

/** What the model is told about an earlier change, so it can build on it ("and day 4 too", or one that wasn't applied). */
function changeNote(c: PlanChange) {
  const what = [c.request, ...opsLines(c.trip), ...stopLines(c.stops)].filter(Boolean).join("; ");
  const st = c.status === "applied" ? "applied" : c.status === "undone" ? "applied, then undone: the trip is as before it"
    : "offered but not applied (the traveler moved on; include it again if they still want it)";
  return `Change ${st}: ${what}`;
}

/** The stop edits in words. */
function stopLines(ops?: StopOp[]) {
  return (ops || []).map((o) => o.op === "add" ? `Day ${o.day}, ${o.time}: add ${o.place}${o.where ? ` (${o.where})` : ""}`
    : o.op === "remove" ? `Day ${o.day}: remove ${o.place}` : `Day ${o.day}: ${o.place} at ${o.time}`);
}

/** Makes the stop edits in the plan itself: no model, nothing else on the day changes. */
function applyStops(ops: StopOp[]) {
  const it = state.itinerary;
  if (!it) return;
  const touched = new Set<number>();
  for (const o of ops) {
    const d = it.days[o.day - 1];
    if (!d) continue;
    const at = d.items.findIndex((x) => samePlace(x.place, o.place));
    if (o.op === "remove" && at >= 0) d.items.splice(at, 1);
    else if (o.op === "time" && at >= 0 && o.time) d.items[at].time = o.time;
    else if (o.op === "add") {
      d.items.push({ time: o.time || "", place: o.place, description: o.description || "", cost: o.cost || 0, kind: o.kind || "sight",
        ...(typeof o.lat === "number" && typeof o.lng === "number" ? { lat: o.lat, lng: o.lng, fixed: true } : {}) });
    } else continue;
    touched.add(o.day - 1);
  }
  for (const i of touched) {
    const d = it.days[i];
    d.items.sort((a, b) => (a.time && b.time ? a.time.localeCompare(b.time) : 0));
    d.estimatedCost = d.items.reduce((n, x) => n + (Number(x.cost) || 0), 0);
  }
  it.totalEstimatedCost = it.days.reduce((n, d) => n + (Number(d.estimatedCost) || 0), 0);
}

/** The setup changes in words. */
function opsLines(t?: TripOps) {
  if (!t) return [];
  return [
    ...(t.onTheWay || []).map((p) => `${p}: on the way between stays (no day trip)`),
    ...(t.fromStay || []).map((p) => `${p}: from where you sleep`),
    ...(t.removeDayTrips || []).map((x) => `No day trip to ${x.place}${x.stay ? ` from ${x.stay}` : ""}`),
    ...(t.addDayTrips || []).map((x) => `Day trip to ${x.place} from ${x.stay} (${x.mode})`),
    ...(t.removeMust || []).map((p) => `${p}: no longer a must-see (it stays in your places)`),
    ...(t.rescaleCosts ? [`Costs for ${t.rescaleCosts.to} traveler${t.rescaleCosts.to > 1 ? "s" : ""} instead of ${t.rescaleCosts.from}${t.rescaleCosts.days?.length ? ` on ${dayList(t.rescaleCosts.days)}${t.rescaleCosts.after ? ` (from ${t.rescaleCosts.after} on day ${Math.min(...t.rescaleCosts.days)})` : ""}` : ""}: meals, tickets and fares per person; the car, parking and fuel stay the same. Nothing is re-planned.`] : []),
    ...(t.addPlaces || []).map((x) => `Add ${x.name}${x.where ? ` (${x.where})` : ""} to your places${x.must ? " as a must-see" : ""}`),
  ];
}

/** A question with answers to pick from: buttons (checkboxes and Send when several can apply), and their own answer.
 *  Answered (or no longer the latest message): what they said. */
function askCard(a: Ask, k: number, live: boolean) {
  if (a.answered || !live) return `<div class="cp-ask done"><b>${esc(a.q)}</b>${a.answered ? `<span class="hint">${icon("check")} ${esc(a.answered)}</span>` : ""}</div>`;
  const opts = a.multi
    ? `<div class="cp-ask-multi">${a.options.map((o) => `<label class="ph-check"><input type="checkbox" value="${esc(o)}"> ${esc(o)}</label>`).join("")}<button type="button" class="btn solid" data-ask-send="${k}">Send</button></div>`
    : `<div class="cp-ask-opts">${a.options.map((o) => `<button type="button" class="btn" data-ask="${k}" data-answer="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
  return `<div class="cp-ask" data-ask-card="${k}"><b>${esc(a.q)}</b>${opts}
    <form class="cp-ask-own" data-ask-own="${k}"><input type="text" maxlength="400" placeholder="Or write your own answer…"><button type="submit" class="btn">Send</button></form></div>`;
}

/** Answers the chat's question: noted on its card, and sent as their next message. */
function answer(k: number, text: string) {
  const t = chat()[k];
  if (!t?.ask || !text.trim() || running) return;
  t.ask.answered = text.trim();
  save();
  ask({ text: text.trim(), pictures: [] });
}

/** The change card: what it changes, and (on the latest message only) Apply / Undo. Older cards just say how it went. */
function changeCard(c: PlanChange, k: number, latest: boolean) {
  const parts = entries(c), lines = parts.map((p) => p.text);
  const offered = latest && (c.status || "offered") === "offered";
  const what = c.request
    ? (c.days.length ? `Changes ${dayList(c.days)} only, and only what you asked for; the other days stay exactly as they are.` : "Revises the whole plan, changing only what you asked for.")
    : c.stops?.length && !c.trip ? "Changes just these stops, straight away: nothing else is re-planned."
    : !state.itinerary ? "Changes the trip's setup (your places and day trips); the plan is made from it when you generate."
    : "Changes the trip's setup; the day plans stay as they are.";
  const status = c.status || "offered";
  const inChain = chain?.cards.includes(k) ? chain.cards.length : 0;
  const actions = !latest
    ? (status === "applying" ? `<span class="hint">Changing the plan…</span>`
      : `<span class="hint">${status === "applied" ? `${icon("check")} Applied` : status === "undone" ? "Undone" : "Not applied"}</span>`)
    : status === "skipped" ? `<span class="hint">Not applied.</span><button type="button" class="link-btn" data-apply="${k}">Apply after all</button>`
    : status === "offered" ? `<button type="button" class="btn solid" data-apply="${k}">${icon("check")} Apply</button>${c.request ? `<button type="button" class="btn" data-try="${k}" title="Make the change, then compare before and after; keep it or put everything back">${icon("arrowLeftRight")} Try it &amp; compare</button>` : `<button type="button" class="btn" data-review="${k}" title="See before and after side by side">${icon("arrowLeftRight")} Review</button>`}<button type="button" class="link-btn" data-skip="${k}">Not now</button>`
    : status === "applying" ? `<span class="hint">Changing the plan… (progress in the itinerary)</span>`
    : status === "applied" ? `<span class="ok-text">${icon("check")} Done</span>${inChain ? `<button type="button" class="link-btn" data-undo="${k}">${inChain > 1 ? `Undo all ${inChain} changes` : "Undo"}</button>` : ""}`
    : status === "failed" ? `<span class="hint">Didn't work out.</span><button type="button" class="link-btn" data-apply="${k}">Try again</button>`
    : `<span class="hint">Undone: the trip is as it was.</span>`;
  const head = c.title || (c.request ? c.request.split(/(?<=[.!?])\s/)[0].slice(0, 90) : lines[0] || "Change");
  // One part whose words are the headline: shown once.
  const listed = parts.length === 1 && parts[0].text === head ? [] : parts;
  let impact = c.impact || "";
  if (offered && direct(chosen(c))) { try { const w = wouldBe(chosen(c)); impact = impactLine(w.before, w.after); } catch { /* as it was */ } }
  const chips = c.days.length ? `<div class="cp-chips">${c.days.map((d) => `<span class="cp-chip">Day ${d}</span>`).join("")}</div>` : c.request ? `<div class="cp-chips"><span class="cp-chip">Whole plan</span></div>` : "";
  return `<div class="cp-change${latest ? "" : " old"}"><div class="cp-change-what">${icon("route")} <div class="cp-change-body"><b class="cp-change-title">${esc(head)}</b>${chips}${listed.length ? `<ul class="cp-ops${offered && parts.length > 1 ? " pick" : ""}">${listed.map((p) => offered && parts.length > 1
    ? `<li><label><input type="checkbox" data-part="${k}" value="${esc(p.key)}"${(c.skip || []).includes(p.key) ? "" : " checked"}> ${esc(p.text)}</label></li>` : `<li>${esc(p.text)}</li>`).join("")}</ul>` : ""}${impact ? `<div class="cp-impact">${esc(impact)}</div>` : ""}${c.request ? `<details class="cp-request"><summary>What the planner is told</summary><p>${esc(c.request)}</p></details>` : ""}<span class="hint">${what}</span></div></div><div class="cp-change-act">${actions}</div></div>`;
}

/** The model's thinking above its answer, folded like Claude's: "Thought for 12s" (open and live while it thinks). */
function thinkingHtml(thinking: string, label: string, open: boolean) {
  return `<details class="cp-think"${open ? " open" : ""}><summary>${icon("sparkles")}<span>${esc(label)}</span></summary><div class="cp-think-body">${mdLite(thinking)}</div></details>`;
}

/** The answer being written, while one is (so a redraw for another reason keeps showing it). */
let livePending: Pending | null = null;
/** They opened or closed the live thinking themselves: leave it as they set it. */
let liveTouched = false;

/** Each fold in the log ("Thought for…", Sources, the summary, what the planner is told) by its kind and place among
 *  those of its kind: new messages only add at the end, so this names the same fold across redraws. */
const foldKeys = (log: HTMLElement) => {
  const n: Record<string, number> = {};
  return [...log.querySelectorAll<HTMLDetailsElement>("details")].map((d) => ({ d, key: `${d.className}#${n[d.className] = (n[d.className] || 0) + 1}` }));
};

/**
 * While the answer streams in, only the answer being written changes: its thinking, text and status are updated in
 * place, so the rest of the chat can be read, scrolled and clicked meanwhile (a fold opened stays open, a selection
 * stays selected). False when there's no answer on screen yet to update.
 */
function patchLive(p: Pending) {
  const log = $("#cpLog"), el = log.querySelector<HTMLElement>(".rc-msg.pending");
  if (!el) return false;
  const atEnd = (x: HTMLElement) => x.scrollHeight - x.scrollTop - x.clientHeight < 40;
  const follow = atEnd(log);
  const slot = el.querySelector<HTMLElement>(".cp-live-think")!;
  if (p.thinking) {
    let d = slot.querySelector<HTMLDetailsElement>("details");
    if (!d) {
      slot.innerHTML = thinkingHtml("", "Thinking…", !p.answering && !liveTouched);
      d = slot.querySelector<HTMLDetailsElement>("details")!;
    }
    // A fold the page closes by itself (when the answer starts) isn't theirs.
    d.ontoggle = () => { if (d!.dataset.auto) delete d!.dataset.auto; else liveTouched = true; };
    const body = d.querySelector<HTMLElement>(".cp-think-body")!, bodyFollow = atEnd(body);
    if (d.dataset.text !== p.thinking) { body.innerHTML = mdLite(p.thinking); d.dataset.text = p.thinking; }
    d.querySelector("summary span")!.textContent = p.answering ? `Thought for ${Math.max(1, Math.round(((p.until || Date.now()) - p.since) / 1000))}s` : "Thinking…";
    // Folded away once the answer starts, unless they opened or closed it themselves.
    if (p.answering && d.open && !liveTouched && !d.dataset.folded) { d.dataset.auto = "1"; d.dataset.folded = "1"; d.open = false; }
    if (bodyFollow) body.scrollTop = body.scrollHeight;
  }
  const text = el.querySelector<HTMLElement>(".cp-live-text")!;
  const html = p.text ? mdLite(p.text) : p.answering || !p.thinking ? `<span class="typing"><i></i><i></i><i></i></span>` : "";
  if (text.dataset.html !== html) { text.innerHTML = html; text.dataset.html = html; }
  const status = el.querySelector<HTMLElement>(".cp-status")!;
  status.hidden = !p.status;
  if (status.textContent !== (p.status || "")) status.textContent = p.status || "";
  if (follow) log.scrollTop = log.scrollHeight;
  return true;
}

/** A streamed bit arrived: update the answer in place (the whole log only when it isn't on screen yet). */
function renderLive(p: Pending) { if (!patchLive(p)) render(p); }

function render(pending: Pending | undefined = livePending ?? undefined) {
  const log = $("#cpLog");
  // Every fold stays open or closed as it was across redraws.
  const folds = new Map(foldKeys(log).map(({ d, key }) => [key, d.open]));
  // Follow the newest text only when they're at the bottom already: scrolled up to read, they stay where they are
  // while the answer streams in (each streamed bit redraws the log). Same for the live thinking's own scroll box.
  const atEnd = (el: HTMLElement | null) => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const prevLive = log.querySelector<HTMLElement>(".pending .cp-think[open] .cp-think-body");
  const follow = jumpToEnd || atEnd(log), top = log.scrollTop;
  const liveFollow = atEnd(prevLive), liveTop = prevLive?.scrollTop || 0;
  jumpToEnd = false;
  const turns = chat(), last = turns.length - 1;
  // Buttons only on the very last message: once they write again, the conversation moves on from there.
  // Where the summary ends: a marker you can open to read it.
  const covered = state.chatSummarized || 0;
  const marker = (k: number) => (state.chatSummary && k === covered - 1
    ? `<details class="cp-summary"><summary>${icon("file")} Earlier messages summarized</summary><div class="cp-think-body">${mdLite(state.chatSummary)}</div></details>` : "");
  const pics = (t: Turn) => (t.images?.length ? `<div class="cp-pics">${t.images.map((src) => `<img src="${esc(src)}" alt="" data-zoom title="Click to see it big">`).join("")}</div>` : "");
  // Where the answering model changed: a wavy line with its name.
  const switched = (k: number) => {
    const t = turns[k];
    if (t.role !== "ai" || !t.modelName) return "";
    let j = k - 1;
    while (j >= 0 && (turns[j].role !== "ai" || !turns[j].modelName)) j--;
    return j >= 0 && turns[j].modelName !== t.modelName ? `<div class="cp-switch"><span>${icon("sparkles")} Switched to ${esc(t.modelName)}</span></div>` : "";
  };
  const bubble = (t: Turn, k: number) => t.role === "me" ? `${pics(t)}${t.text ? `<div class="rc-msg me">${esc(t.text)}</div>` : ""}${marker(k)}`
    : `${switched(k)}<div class="rc-msg ai${k === last && pending == null && !["applied", "applying"].includes(t.change?.status || "") ? " last" : ""}">${t.thinking ? thinkingHtml(t.thinking, `Thought for ${t.thoughtSecs || 1}s`, false) : ""}${mdLite(t.text)}${sourcesHtml(t.sources)}${t.change ? changeCard(t.change, k, k === last && pending == null) : ""}${t.ask ? askCard(t.ask, k, k === last && pending == null) : ""}${k === last && pending == null && !["applied", "applying"].includes(t.change?.status || "") ? `<div class="cp-msg-tools"><button type="button" class="link-btn" data-retry title="Ask again (a new answer replaces this one)">${icon("refresh")} Retry</button></div>` : ""}</div>${marker(k)}`;
  const hasPlan = !!state.itinerary?.days?.length;
  const starters = hasPlan
    ? ["Check my plan", "What's the plan for tomorrow?", "What should we book ahead?", "Make the busiest day more relaxed", "Where should we eat near our hotel?", "Is anything closed on the days we're there?"]
    : ["Is this route realistic?", "What's the weather like then?", "What should we not miss?", "What should we pack?"];
  log.innerHTML = turns.map(bubble).join("")
    // The answer being written: filled in (and then updated in place) by patchLive.
    + (pending != null ? `<div class="rc-msg ai pending"><div class="cp-live-think"></div><div class="cp-live-text"></div><div class="cp-status" hidden></div></div>` : "")
    + (notice && pending == null ? `<div class="cp-notice">${notice}</div>` : "")
    || `<div class="cp-empty"><div class="cp-empty-icon">${icon("chat")}</div>
        <p><b>Ask anything about your trip</b></p>
        <p class="hint">${hasPlan ? "What's on a day, where to eat, what to book, how to get around. Or ask for a change (“swap days 3 and 4”) and apply it from here." : "Questions about the places, the season or the route. Once there's a plan, you can change it from here too."}</p>
        <div class="cp-starters">${starters.map((q) => `<button type="button" class="chip-btn" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div></div>`;
  log.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => { b.onclick = () => { box().value = b.dataset.q!; ask(); }; });
  log.querySelectorAll<HTMLButtonElement>("[data-apply]").forEach((b) => { b.onclick = () => apply(+b.dataset.apply!); });
  // The chat's question: an answer picked, several ticked and sent, or their own written.
  log.querySelectorAll<HTMLButtonElement>("[data-ask]").forEach((b) => { b.onclick = () => answer(+b.dataset.ask!, b.dataset.answer!); });
  log.querySelectorAll<HTMLButtonElement>("[data-ask-send]").forEach((b) => {
    b.onclick = () => {
      const picked = [...b.closest(".cp-ask")!.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")].map((c) => c.value);
      if (picked.length) answer(+b.dataset.askSend!, picked.join(", "));
    };
  });
  log.querySelectorAll<HTMLFormElement>("[data-ask-own]").forEach((f) => {
    f.onsubmit = (e) => { e.preventDefault(); answer(+f.dataset.askOwn!, f.querySelector("input")!.value); };
  });
  log.querySelectorAll<HTMLButtonElement>("[data-skip]").forEach((b) => { b.onclick = () => setStatus(+b.dataset.skip!, "skipped"); });
  log.querySelectorAll<HTMLButtonElement>("[data-undo]").forEach((b) => { b.onclick = () => undo(); });
  log.querySelectorAll<HTMLButtonElement>("[data-review]").forEach((b) => { b.onclick = () => review(+b.dataset.review!); });
  log.querySelectorAll<HTMLButtonElement>("[data-try]").forEach((b) => { b.onclick = () => tryIt(+b.dataset.try!); });
  log.querySelectorAll<HTMLInputElement>("[data-part]").forEach((x) => {
    x.onchange = () => {
      const c = chat()[+x.dataset.part!]?.change;
      if (!c) return;
      const skip = new Set(c.skip || []);
      if (x.checked) skip.delete(x.value); else skip.add(x.value);
      c.skip = [...skip];
      c.impact = direct(chosen(c)) ? impactLine(...Object.values(wouldBe(chosen(c))) as [Snapshot, Snapshot]) : "";
      save(); render();
    };
  });
  linkPlaces(log);
  if (pending) patchLive(pending);
  for (const { d, key } of foldKeys(log)) if (folds.has(key)) d.open = folds.get(key)!;
  // The live thinking scrolls to its newest line (unless they scrolled up in it); then the log.
  const live = log.querySelector<HTMLElement>(".pending .cp-think[open] .cp-think-body");
  if (live) live.scrollTop = liveFollow ? live.scrollHeight : liveTop;
  log.scrollTop = follow ? log.scrollHeight : top;
  idle();
}

function setStatus(k: number, status: ChangeState) {
  const t = chat()[k];
  if (t?.change) { t.change.status = status; save(); render(); }
}

/** The place in the trip a name means ("Burg Hohenwerfen, Austria" → "Burg Hohenwerfen"), or the name itself. */
function placeTitle(name: string) {
  const n = sameName(name), ps = session.places;
  return (ps.find((p) => p.title === name) || ps.find((p) => sameName(p.title) === n)
    || ps.find((p) => { const m = sameName(p.title); return m.length > 3 && (m.includes(n) || n.includes(m)); }))?.title || name;
}
const sameStay = (city: string, name: string) => { const a = sameName(city), b = sameName(name); return !b || a === b || a.startsWith(b) || b.startsWith(a); };
const samePlace = (a: string, b: string) => { const x = sameName(a), y = sameName(b); return x === y || (y.length > 3 && x.includes(y)) || (x.length > 3 && y.includes(x)); };

/** The setup changes: must-sees on the way or from a stay (a must-see then, if it wasn't), the stays' day trips. */
function applyOps(t: TripOps) {
  const fit = (name: string, how: MustSeeHow) => {
    const title = placeTitle(name), p = session.places.find((x) => x.title === title);
    if (p && state.marks[title] !== "must") { state.marks[title] = "must"; keepPlace(p); }
    applyHow(title, how);
    // Also by its name as written, in case the day trip was entered differently.
    if (how === "way") for (const s of state.stays) s.dayTrips = (s.dayTrips || []).filter((d) => !samePlace(d.place, name) && !samePlace(d.place, title));
  };
  for (const name of t.onTheWay || []) fit(name, "way");
  for (const name of t.fromStay || []) fit(name, "stay");
  for (const r of t.removeDayTrips || []) for (const s of state.stays) {
    if (sameStay(s.city, r.stay)) s.dayTrips = (s.dayTrips || []).filter((d) => !samePlace(d.place, r.place));
  }
  // New places (one recognised in a picture, say): as places picked by them; they're located on the map afterwards.
  for (const a of t.addPlaces || []) {
    const known = session.places.find((p) => samePlace(p.title, a.name));
    const title = known?.title || a.name;
    if (!known) state.customPlaces = [...state.customPlaces, { title, address: a.where, custom: true }];
    if (a.must) state.marks[title] = "must";
  }
  // No longer must-sees: the mark and how it was to be fitted in go; the place stays among their ideas.
  if (t.rescaleCosts && state.itinerary) {
    rescaleCosts(state.itinerary, t.rescaleCosts.from, t.rescaleCosts.to, t.rescaleCosts.days, t.rescaleCosts.after);
    // Only a change for the whole trip changes who the plan is for.
    if (state.meta && !t.rescaleCosts.days?.length) state.meta = { ...state.meta, travelers: t.rescaleCosts.to, budget: groupBudget() };
  }
  for (const name of t.removeMust || []) {
    const title = placeTitle(name);
    if (state.marks[title] === "must") { delete state.marks[title]; if (state.how) delete state.how[title]; }
  }
  for (const a of t.addDayTrips || []) {
    const s = state.stays.find((x) => sameStay(x.city, a.stay));
    if (s && !(s.dayTrips || []).some((d) => samePlace(d.place, a.place))) s.dayTrips = [...(s.dayTrips || []), { place: a.place, mode: a.mode as never }];
  }
}

/** After the setup or the plan changed (or went back): redraw everything that shows them. */
function refreshAll() {
  setListPlaces(session.listPlaces);
  save();
  renderStays(); renderChips(); renderItinerary(); drawMap({ fit: false }); geocodeItems(); geocodePlaces();
}

/** Applies a change: the setup first, then the days it touches (only what was asked; the other days stay exactly as they
 *  are), or the whole plan when it's all over it. Undo later goes back to before the first change of the series. */
async function apply(k: number) {
  const full = chat()[k]?.change, it = state.itinerary;
  const c = full && chosen(full);
  // Without a plan only the setup can change (must-sees, day trips).
  if (!c || (!it && (c.request || c.stops?.length))) return;
  const now = capture(), snap = chain?.snap ?? now;
  setStatus(k, "applying");
  if (c.trip) { applyOps(c.trip); refreshAll(); }
  if (c.stops?.length) { applyStops(c.stops); refreshAll(); }
  if (c.edits?.length) { applyEdits(c.edits); refreshAll(); }
  let ok = true;
  if (c.request && it) {
    const days = c.days.filter((d) => d >= 1 && d <= it.days.length).map((d) => d - 1);
    ok = await runGeneration(days.length ? { edit: { itinerary: state.itinerary!, days, request: c.request } } : { revise: { itinerary: state.itinerary!, request: c.request } });
    // The plan couldn't be changed: the setup goes back too, so nothing is half done.
    if (!ok && (c.trip || c.edits?.length || c.stops?.length)) { Object.assign(state, now); refreshAll(); }
  }
  if (ok) chain = { snap, cards: [...(chain?.cards || []), k] };
  setStatus(k, ok ? "applied" : "failed");
}

/** Stops to add more than ~15 km from that day's other stops become a planner request for that day (re-planned around
 *  them: the drive there and back, the visit, and what no longer fits), instead of being slotted in as they are. */
function farStops(c: PlanChange) {
  const it = state.itinerary;
  if (!it) return;
  const byTitle = byTitleMap(), keep: StopOp[] = [], asks: string[] = [], days = new Set(c.days);
  for (const o of c.stops || []) {
    const d = it.days[o.day - 1];
    const locs = d ? d.items.map((x) => itemLoc(x, d, byTitle)).filter((l): l is NonNullable<typeof l> => !!l && !l.elsewhere) : [];
    const far = o.op === "add" && typeof o.lat === "number" && typeof o.lng === "number" && locs.length && Math.min(...locs.map((l) => distKm(l, { lat: o.lat!, lng: o.lng! }))) > 15;
    if (!far) { keep.push(o); continue; }
    asks.push(`On day ${o.day}, add ${o.place}${o.where ? ` (${o.where})` : ""}${o.time ? ` at about ${o.time}` : ""}, and re-plan the rest of that day around it: the real drive there and on afterwards, how long the visit takes, and move or drop what no longer fits (later stops, dinner, the evening); keep everything else as it is.`);
    days.add(o.day);
  }
  if (!asks.length) return;
  c.stops = keep.length ? keep : undefined;
  c.request = [c.request, ...asks].filter(Boolean).join(" ");
  c.days = [...days].sort((a, b) => a - b);
}

/** Before and after for a change the page makes itself, side by side; Apply from there. */
function review(k: number) {
  const c = chat()[k]?.change;
  if (!c) return;
  const { before, after } = wouldBe(chosen(c));
  openReview(c.title || "Before and after", before, after, [
    { label: "Apply", primary: true, run: () => apply(k) },
    { label: "Not now", run: () => setStatus(k, "skipped") },
  ]);
}

/** A change only the planner can make: made, then compared with before; kept, or everything put back. */
async function tryIt(k: number) {
  const c = chat()[k]?.change;
  if (!c) return;
  const before = capture();
  await apply(k);
  if (chat()[k]?.change?.status !== "applied") return;
  const after = capture();
  openReview(c.title || "Before and after", before, after, [
    { label: "Keep it", primary: true, run: () => {} },
    { label: "Put it back", run: () => {
      Object.assign(state, structuredClone(before));
      if (chain) { chain.cards = chain.cards.filter((x) => x !== k); if (!chain.cards.length) chain = null; }
      refreshAll(); setStatus(k, "undone");
    } },
  ]);
}

/** Words that are part of many stop names and name no place by themselves. */
const NOT_A_PLACE = /^(lunch|dinner|breakfast|brunch|coffee|drinks|hotel|check[- ]?(in|out)|free time|old town|city centre|city center|walk|stroll|hike|boat|ferry|train|bus|cruise|tour|visit|return|arrival|departure|day trip)$/i;

/** A place an answer can name: where it is, or (a town only named in a day's heading) what to look up near where. */
type Spot = { lat: number; lng: number; zoom: number } | { query: string; near?: { lat: number; lng: number }; zoom: number };

/** Where each place the plan knows is, by name in lower case: the stops (also by the parts of a name like "Vitznau pier
 *  & Rigi railway" or "Lion Monument (Löwendenkmal)"), the towns they stay in, and the towns in each day's heading
 *  (looked up when clicked). Longer names win where they overlap. */
function knownSpots() {
  const it = state.itinerary, byTitle = byTitleMap(), spots = new Map<string, Spot>();
  const add = (name: string, spot: Spot) => {
    const n = name.trim();
    if (n.length >= 4 && /\p{Lu}/u.test(n[0]) && !NOT_A_PLACE.test(n) && !spots.has(n.toLowerCase())) spots.set(n.toLowerCase(), spot);
  };
  for (const d of it?.days || []) for (const x of d.items) {
    const loc = itemLoc(x, d, byTitle);
    if (!loc) continue;
    const at = { lat: loc.lat, lng: loc.lng, zoom: 15 };
    add(x.place, at);
    // Without brackets, what's in them ("Löwendenkmal"), and each of several places in one stop. Not "Boat to Vitznau":
    // the stop is where the boat leaves, not Vitznau.
    const bare = x.place.replace(/\s*\([^)]*\)/g, "");
    add(bare, at);
    for (const inside of x.place.match(/\(([^)]+)\)/g) || []) add(inside.slice(1, -1), at);
    if (!/\s(to|→)\s/i.test(bare)) for (const part of bare.split(/\s+(?:&|\+|and|-|–|—|\/)\s+/)) add(part, at);
  }
  // The towns they stay in, also as "Lucerne" from "Lucerne, Switzerland".
  for (const s of state.stays) {
    const loc = stayLoc(s);
    if (loc && s.city) { const at = { lat: loc.lat, lng: loc.lng, zoom: 13 }; add(s.city, at); add(s.city.split(",")[0], at); }
  }
  // The towns in a day's heading ("Lucerne / Vitznau / Rigi"): looked up near that day's stay when clicked.
  for (const d of it?.days || []) {
    const stay = stayOn(d), near = stay ? stayLoc(stay) : undefined;
    for (const town of d.city.split(/\s*(?:\/|,|&|\+|→|\band\b|\s-\s|\s–\s)\s*/)) add(town, { query: town.trim(), near: near ? { lat: near.lat, lng: near.lng } : undefined, zoom: 13 });
  }
  return spots;
}

/** Towns looked up from a click, so a second click doesn't ask again. */
const lookedUp = new Map<string, { lat: number; lng: number } | null>();

/** Names of places the plan knows, in an answer, become links that show the place on the map. Whole words only: "Luce"
 *  doesn't light up inside "Lucerne". */
function linkPlaces(log: HTMLElement) {
  if (!state.itinerary || !mapModule.map) return;
  const spots = knownSpots();
  if (!spots.size) return;
  const names = [...spots.keys()].sort((a, b) => b.length - a.length).slice(0, 400);
  const pattern = `(?<![\\p{L}\\p{N}])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`;
  // A fresh expression for each test: one with the "g" flag remembers where it stopped and would skip matches.
  const found = (s: string) => new RegExp(pattern, "iu").test(s);
  for (const msg of log.querySelectorAll<HTMLElement>(".rc-msg.ai:not(.pending)")) {
    const walk = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest("a, button, details, .cp-change, .cp-place") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const nodes: Text[] = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (found((n as Text).data)) nodes.push(n as Text);
    for (const n of nodes) {
      // Split the raw text and build the nodes, rather than matching escaped HTML (where "&" is "&amp;").
      const out: Node[] = [];
      let last = 0;
      for (const m of n.data.matchAll(new RegExp(pattern, "giu"))) {
        if (m.index! > last) out.push(document.createTextNode(n.data.slice(last, m.index)));
        const b = document.createElement("button");
        b.type = "button"; b.className = "cp-place"; b.dataset.fly = m[1].toLowerCase(); b.title = "Show on the map"; b.textContent = m[1];
        out.push(b);
        last = m.index! + m[1].length;
      }
      if (last < n.data.length) out.push(document.createTextNode(n.data.slice(last)));
      n.replaceWith(...out);
    }
  }
  log.querySelectorAll<HTMLButtonElement>("[data-fly]").forEach((b) => {
    b.onclick = async () => {
      const spot = spots.get(b.dataset.fly!);
      if (!spot || !mapModule.map) return;
      let at: { lat: number; lng: number } | null = "lat" in spot ? spot : lookedUp.get(spot.query) ?? null;
      if (!at && "query" in spot && !lookedUp.has(spot.query)) {
        try {
          const params = new URLSearchParams({ q: spot.query, ...(spot.near ? { lat: spot.near.lat.toFixed(4), lng: spot.near.lng.toFixed(4) } : {}) });
          const hit = (await api<GeoHit[]>(`/api/search?${params}`))[0];
          at = hit ? { lat: hit.lat, lng: hit.lng } : null;
        } catch { at = null; }
        lookedUp.set(spot.query, at);
      }
      const m = mapModule.map;
      if (!at || !m) { toast(`Couldn't find ${b.textContent} on the map`); return; }
      // The map stays there: redraws (lookups and routes arriving) don't fit it back to the whole trip.
      session.userMoved = true;
      moveTo(m, [at.lat, at.lng], spot.zoom);
    };
  });
}

/** What the page knows beyond the trip text, for "LOOKUP: trip | topic". */
function appData(): Record<string, string> {
  const it = state.itinerary, cur = state.currency, out: Record<string, string> = {};
  if (!it?.days.length) return out;
  const perDay = (Number(state.dailyBudget) || 0) * Math.max(1, Number(state.travelers) || 1);
  out.costs = [`Budget: ${perDay} ${cur} a day for the group (${state.dailyBudget} per person, ${state.travelers} traveler${state.travelers > 1 ? "s" : ""}); costs in the plan are the planner's estimates for the whole group.`,
    ...it.days.map((d, i) => `Day ${i + 1} (${d.date}, ${d.city}): ${Number(d.estimatedCost) || 0} ${cur}${perDay && Number(d.estimatedCost) > perDay ? ` (over the budget by ${Math.round(Number(d.estimatedCost) - perDay)})` : ""}`),
    `Total: ${it.totalEstimatedCost ?? it.days.reduce((n, d) => n + (Number(d.estimatedCost) || 0), 0)} ${cur}; budget for the trip ${perDay * it.days.length} ${cur}.`].join("\n");
  const f = fuelEstimate();
  out.fuel = f ? [`Fuel estimate: ${Math.round(f.eur)} EUR for ${f.km} km by car at ${f.per100} per 100 km.`, ...f.perDay.map((d) => `Day ${d.di + 1}: ${d.km} km driving, ${Math.round(d.eur)} EUR`)].join("\n")
    : "No fuel estimate (no car fuel type set in the cost breakdown).";
  const long = drives().filter((d) => d.km > 350).map((d) => `Day ${d.di + 1}: ${d.km} km of driving`);
  const problems = planProblems(it).map((p) => `Day ${p.day + 1}: ${p.text}`);
  const over = it.days.map((d, i) => (perDay && Number(d.estimatedCost) > perDay ? `Day ${i + 1}: over the daily budget (${d.estimatedCost} of ${perDay} ${cur})` : "")).filter(Boolean);
  out.checks = [...problems, ...long.map((x) => `${x} (a long drive day)`), ...over].join("\n") || "The checks found nothing: no stops in the wrong place or closed at their time, no very long drive days, no day over budget.";
  const w = it.days.map((d, i) => (session.weather[d.date] ? `Day ${i + 1} (${d.date}): weather code ${session.weather[d.date].code}, ${session.weather[d.date].min}-${session.weather[d.date].max} °C` : "")).filter(Boolean);
  out.weather = w.length ? `Forecast (Open-Meteo):\n${w.join("\n")}` : "No forecast yet: forecasts are only available for days in the next two weeks.";
  out.places = session.places.slice(0, 400).map((p) => `- ${p.title}${state.marks[p.title] ? ` [${state.marks[p.title]}]` : ""}${p.address ? ` (${p.address})` : ""}`).join("\n") || "No saved places.";
  const book = bookAheadList(it).map((r) => `[${r.done ? "x" : " "}] ${r.label}`);
  out.bookings = [...(state.bookings || []).map((b) => `Their bookings: ${b.name} on ${b.date}${b.from ? ` ${b.from}` : ""}`),
    book.length ? `"Book ahead" checklist ([x] = ticked off as booked):\n${book.join("\n")}` : "Nothing on the Book ahead list."].join("\n");
  const packed = state.packed || {};
  out.packing = [`Packing list ([x] = packed):`, ...packingList(it).map((g) => `${g.title}: ${g.items.map((x) => `[${packed[x.text] ? "x" : " "}] ${x.text}`).join("; ")}`),
    `Their own items: ${(state.packingExtra || []).map((t) => `[${packed[t] ? "x" : " "}] ${t}`).join("; ") || "none"}`].join("\n");
  return out;
}

/** Puts back everything applied since the first change of the series. */
function undo() {
  if (!chain) return;
  Object.assign(state, structuredClone(chain.snap));
  const cards = chain.cards;
  chain = null;
  refreshAll();
  for (const k of cards) { const t = chat()[k]; if (t?.change) t.change.status = "undone"; }
  save(); render();
}

/** A picture shrunk to fit `max` pixels, as JPEG (base64 without the prefix, and as a data URL). */
async function shrink(file: File, max: number, quality: number) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", quality);
    return { dataUrl, data: dataUrl.split(",")[1] };
  } finally { URL.revokeObjectURL(url); }
}

/** Attaches pictures to the next message (at most 4). */
async function addPictures(files: File[]) {
  for (const f of files.slice(0, 4 - pictures.length)) {
    try {
      const [big, small] = await Promise.all([shrink(f, 1600, 0.85), shrink(f, 240, 0.7)]);
      pictures.push({ type: "image/jpeg", data: big.data, thumb: small.dataUrl });
      fullSize.set(small.dataUrl, big.dataUrl);
    } catch { setNotice(esc(`Couldn't read ${f.name} as a picture.`)); }
  }
  renderPictures();
  box().focus();
}

function renderPictures() {
  const el = $("#cpAttach");
  el.hidden = !pictures.length;
  el.innerHTML = pictures.map((p, k) => `<span class="cp-thumb"><img src="${p.thumb}" alt="" data-zoom title="Click to see it big"><button type="button" data-unpic="${k}" title="Remove">${icon("x")}</button></span>`).join("");
  idle();
}

/** A message as the model gets it: changes with how they went. */
const turnText = (t: Turn) => ({ role: t.role, text: `${t.images?.length ? `(sent ${t.images.length} picture${t.images.length > 1 ? "s" : ""}) ` : ""}${t.text}${t.change ? `\n(${changeNote(t.change)})` : ""}${t.ask ? `\n(Asked: ${t.ask.q} Answers offered: ${t.ask.options.join(" / ")})` : ""}` });

/** About how many tokens some text is (a token is roughly 4 characters). */
const tokensIn = (text: string) => Math.round(text.length / 4);
/** What the conversation since the last summary costs on every message, and what compacting it all would free (the
 *  messages minus the summary that replaces them). */
function contextUse() {
  const from = state.chatSummarized || 0, turns = chat().slice(from);
  const tokens = turns.reduce((n, t) => n + tokensIn(turnText(t).text), 0) + tokensIn(state.chatSummary || "");
  const fill = Math.max(tokens / COMPACT_TOKENS, turns.length / COMPACT_MESSAGES);
  return { messages: turns.length, tokens, fill, freed: Math.max(0, tokens - Math.min(tokens, 350)) };
}

/** The ring by the chat box (like Claude Code's): it fills up until the chat summarizes itself; clicking it does so now. */
function ringHtml(fill: number) {
  const r = 7, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, fill));
  return `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2.4"/>`
    + `<circle cx="9" cy="9" r="${r}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 9 9)"/></svg>`;
}

/** Summarizes the messages up to `upTo` (with the summary before them) so long chats stay quick; the messages stay on
 *  screen, with a marker where the summary ends. Without a summary (it failed), the chat just carries on. */
async function compact(upTo: number) {
  const from = state.chatSummarized || 0;
  if (upTo <= from || compacting) return;
  compacting = true;
  const before = contextUse().tokens;
  setNotice("Summarizing the earlier conversation…");
  try {
    const { summary } = await streamRequest<{ summary: string }>("/api/companion/compact", {
      model: chatModel(), turns: chat().slice(from, upTo).map(turnText), summary: state.chatSummary || "",
    }, (l) => { setNotice(esc(`${l.status}${l.tokens ? ` · ${l.tokens} tokens` : ""}`)); });
    state.chatSummary = summary; state.chatSummarized = upTo;
    save();
    const freed = Math.max(0, before - contextUse().tokens);
    notice = esc(`Summarized ${upTo - from} message${upTo - from === 1 ? "" : "s"}: about ${freed.toLocaleString()} tokens freed.`);
  } catch (e) { notice = esc(`Couldn't summarize: ${(e as Error).message}`); }
  finally { compacting = false; render(); }
}
let compacting = false;

/** The chat's model menu: "Same as planning (…)" and every model the planning menu has (its actions left out). */
function syncModels() {
  const pick = $<HTMLSelectElement>("#cpModel"), main = $<HTMLSelectElement>("#model");
  const opts = [...main.options].filter((o) => o.value && !o.value.startsWith("__"));
  const planning = main.selectedOptions[0]?.textContent?.trim() || "the planning model";
  const want = state.chatModel && opts.some((o) => o.value === state.chatModel) ? state.chatModel : "";
  const html = `<option value="">Same as planning (${esc(planning)})</option>` + opts.map((o) => `<option value="${esc(o.value)}">${esc(o.textContent?.trim() || o.value)}</option>`).join("");
  if (pick.dataset.html !== html) { pick.innerHTML = html; pick.dataset.html = html; }
  pick.value = want;
}

/** The model that answers in the chat. */
const chatModel = () => (state.chatModel && [...$<HTMLSelectElement>("#model").options].some((o) => o.value === state.chatModel) ? state.chatModel : state.model);

/** The send button, or while it answers, a stop button in its place (like Claude Code's). */
function idle() {
  const send = $<HTMLButtonElement>("#cpSend"), busy = !!running;
  if (send.classList.contains("stop") !== busy) {
    send.classList.toggle("stop", busy);
    send.innerHTML = icon(busy ? "stop" : "arrowUp");
    send.title = busy ? "Stop" : "Send (Enter) · new line with Shift+Enter";
  }
  send.disabled = !busy && !box().value.trim() && !pictures.length;
  const ring = $<HTMLButtonElement>("#cpCompact"), use = contextUse();
  ring.hidden = busy || use.messages < 2;
  if (!ring.hidden) {
    const fill = Math.min(1, use.fill);
    ring.innerHTML = ringHtml(fill);
    ring.classList.toggle("near", fill >= 0.75);
    ring.title = `About ${use.tokens.toLocaleString()} of ${COMPACT_TOKENS.toLocaleString()} tokens of conversation (${use.messages} message${use.messages === 1 ? "" : "s"}) before the chat summarizes itself.`
      + `\nClick to summarize now: frees about ${use.freed.toLocaleString()} tokens.`;
    ring.setAttribute("aria-label", `Summarize the conversation now (${Math.round(fill * 100)}% until it happens by itself)`);
  }
  syncModels();
}

function fit() {
  const b = box();
  b.style.height = "auto";
  b.style.height = `${Math.min(b.scrollHeight, 180)}px`;
}

/** Retry: the last message asked again (its answer, or the error, replaced). Its pictures go again too: full size while
 *  the page is open, else the small copy kept with the chat. */
function retry() {
  if (running || compacting) return;
  const turns = chat();
  let u = turns.length - 1;
  while (u >= 0 && turns[u].role !== "me") u--;
  if (u < 0) return;
  const me = turns[u];
  const pics: Picture[] = (me.images || []).map((thumb) => {
    const src = fullSize.get(thumb) || thumb;
    return { type: "image/jpeg", data: src.split(",")[1] || "", thumb };
  }).filter((p) => p.data);
  state.chat = turns.slice(0, u);
  if (chain && chain.cards.some((k) => k >= u)) chain = null;
  ask({ text: me.text, pictures: pics });
}

async function ask(again?: { text: string; pictures: Picture[] }) {
  const typed = again ? again.text : box().value.trim();
  const sent = again ? again.pictures : pictures;
  const question = typed || (sent.length ? "What is this place?" : "");
  if (!question || running || compacting) return;
  if (!again) { pictures = []; renderPictures(); }
  notice = "";
  // A long chat is compacted first: the older messages summarized (the most recent few stay as they are).
  if (contextUse().fill >= 1) await compact(chat().length - KEEP_RECENT);
  // What came before (after the summary), with the changes and how they went, so "undo that" or "and day 4 too" make sense.
  const history = chat().slice(Math.max(state.chatSummarized || 0, chat().length - COMPACT_MESSAGES)).map(turnText);
  state.chat = [...chat(), { role: "me" as const, text: typed || (sent.length ? "" : question), ...(sent.length ? { images: sent.map((p) => p.thumb) } : {}) }];
  save();
  jumpToEnd = true;
  if (!again) { box().value = ""; fit(); }
  running = new AbortController();
  const pending: Pending = { text: "", thinking: "", since: 0, until: 0, answering: false };
  livePending = pending; liveTouched = false;
  render(pending);
  try {
    const { answer, change, thinking, thoughtSecs, sources, question: asked } = await streamRequest<{ answer: string; change?: PlanChange; thinking?: string; thoughtSecs?: number; sources?: Source[]; question?: Ask }>("/api/companion", {
      model: chatModel(), mode: mode(), data: appData(),
      dayAt: Object.fromEntries((state.itinerary?.days || []).map((d, i) => [i + 1, stayOn(d) && stayLoc(stayOn(d)!)]).filter(([, l]) => l).map(([k, l]) => [k, [(l as { lat: number }).lat, (l as { lng: number }).lng]])), question, history, summary: state.chatSummary || "", images: sent.map(({ type, data }) => ({ type, data })), context: tripContext(), today: todayIso(), days: state.itinerary?.days?.length || 0,
      towns: state.stays.filter((s) => s.city).map((s) => ({ s, l: stayLoc(s) })).filter((x) => x.l).map(({ s, l }) => ({ name: s.city, lat: l!.lat, lng: l!.lng })),
    }, (l) => {
      const status = `${l.status}${l.tokens ? ` · ${l.tokens} tokens` : ""} · ${l.seconds} s`;
      if (status !== pending.status) { pending.status = status; renderLive(pending); }
      if (l.thinking && l.thinking !== pending.thinking) { pending.since ||= Date.now(); pending.thinking = l.thinking; renderLive(pending); }
      if (l.reasoning && l.reasoning !== pending.text) { if (!pending.answering) pending.until = Date.now(); pending.answering = true; pending.text = l.reasoning; renderLive(pending); }
    }, running.signal);
    const modelName = ($<HTMLSelectElement>("#cpModel").selectedOptions[0]?.textContent || chatModel()).trim();
    state.chat = [...chat(), { role: "ai" as const, text: answer, modelName, ...(thinking ? { thinking, thoughtSecs } : {}), ...(sources?.length ? { sources } : {}), ...(change ? { change: { ...change, status: "offered" as const } } : {}), ...(asked ? { ask: asked } : {}) }];
    // A stop added far from the day's other stops can't just be slotted in: the planner re-plans that day around it.
    const got = chat()[chat().length - 1].change;
    if (got?.stops?.length) farStops(got);
    // What a change the page makes itself does to the money and nights, for the card.
    const added = chat()[chat().length - 1].change;
    if (added && direct(added)) { try { const w = wouldBe(added); added.impact = impactLine(w.before, w.after); } catch { /* shown without it */ } }
    // Auto mode: a small change happens straight away (Undo is on its card); anything bigger waits for Apply.
    if (change && mode() === "auto" && small(change)) autoApply = chat().length - 1;
  } catch (e) {
    const err = e as Error;
    notice = `${esc(err.name === "AbortError" ? "Stopped." : `Couldn't answer: ${err.message}`)} <button type="button" class="link-btn" data-retry>${icon("refresh")} Retry</button>`;
  } finally {
    running = null; livePending = null;
    save();
    render();
    if (autoApply >= 0) { const k = autoApply; autoApply = -1; apply(k); }
  }
}

/** Shows or hides the chat column (remembered in this browser); the map is told its size changed. */
function setOpen(open: boolean) {
  markHeader();
  panel().hidden = !open;
  if (open) { const log = $("#cpLog"); log.scrollTop = log.scrollHeight; }
  document.body.classList.toggle("chat-open", open);
  $("#chatBtn").setAttribute("aria-pressed", String(open));
  localStorage.setItem(OPEN_KEY, open ? "1" : "");
  requestAnimationFrame(() => mapModule.map?.invalidateSize());
  document.body.classList.toggle("chat-cover", open && window.innerWidth <= 900);
  fitViewport();
  if (open) { render(); fit(); }
}

/** On a phone the chat covers the screen: sized to the part you can see, so the on-screen keyboard (Safari on iOS
 *  shrinks the visible area, not the page) doesn't push the box out of sight or the page sideways. */
function fitViewport() {
  const vv = window.visualViewport, el = panel();
  if (!vv || window.innerWidth > 900 || el.hidden) { el.style.removeProperty("height"); el.style.removeProperty("top"); el.style.removeProperty("bottom"); return; }
  el.style.height = `${Math.round(vv.height)}px`;
  el.style.top = `${Math.round(vv.offsetTop)}px`;
  el.style.bottom = "auto";
}

/** Where the header ends, for the chat drawer on smaller screens to start just below it. */
function markHeader() {
  const h = document.querySelector("header")?.getBoundingClientRect().bottom || 80;
  document.documentElement.style.setProperty("--head", `${Math.round(h)}px`);
}

/** Opens the chat (with `text` in the box, if given) and puts the cursor there. */
export function openChat(text?: string) {
  setOpen(true);
  if (text != null && !box().value) box().value = text;
  fit(); idle();
  box().focus();
}

export function initCompanion() {
  $("#chatBtn").onclick = () => (panel().hidden ? openChat() : setOpen(false));
  // The chat's own model (or the planning one); the menu follows the planning menu as models come and go.
  $<HTMLSelectElement>("#cpModel").onchange = (e) => { state.chatModel = (e.target as HTMLSelectElement).value; save(); };
  const main = $<HTMLSelectElement>("#model");
  main.addEventListener("change", syncModels);
  new MutationObserver(syncModels).observe(main, { childList: true });
  $("#cpClose").onclick = () => setOpen(false);
  $<HTMLFormElement>("#cpForm").onsubmit = (e) => { e.preventDefault(); if (running) running.abort(); else ask(); };
  box().addEventListener("input", () => { fit(); idle(); });
  box().addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }
    // Shift+Tab switches the mode, as in Claude Code.
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); nextMode(); }
  });
  // The message box floats over the log: the log keeps room for it at the end, however tall it grows.
  const form = document.querySelector<HTMLElement>("#cpForm");
  if (form) new ResizeObserver(() => panel().style.setProperty("--cp-input-h", `${form.offsetHeight}px`)).observe(form);
  document.querySelector<HTMLButtonElement>("#cpMode")?.addEventListener("click", () => renderMode(!document.querySelector("#cpModeMenu")));
  renderMode();
  $("#cpBox").onclick = (e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("cp-tools-fill")) box().focus(); };
  // Pictures: the button, pasting one into the box, or dropping one on the chat.
  const file = $<HTMLInputElement>("#cpImage");
  file.onchange = () => { addPictures([...(file.files || [])]); file.value = ""; };
  box().addEventListener("paste", (e) => {
    const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); addPictures(imgs); }
  });
  panel().addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); $("#cpBox").classList.add("over"); } });
  panel().addEventListener("dragleave", (e) => { if (e.target === panel()) $("#cpBox").classList.remove("over"); });
  panel().addEventListener("drop", (e) => {
    e.preventDefault(); $("#cpBox").classList.remove("over");
    addPictures([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/")));
  });
  $("#cpAttach").onclick = (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("[data-unpic]")?.dataset.unpic;
    if (k != null) { pictures.splice(+k, 1); renderPictures(); return; }
    const img = (e.target as HTMLElement).closest<HTMLImageElement>("img[data-zoom]");
    if (img) showPicture(fullSize.get(img.getAttribute("src")!) || img.getAttribute("src")!);
  };
  $("#cpLog").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-retry]")) { retry(); return; }
    const img = (e.target as HTMLElement).closest<HTMLImageElement>("img[data-zoom]");
    if (img) showPicture(fullSize.get(img.getAttribute("src")!) || img.getAttribute("src")!);
  });
  $("#cpClear").onclick = async () => {
    if (!chat().length || await askConfirm({ title: "Clear the conversation?", text: "The messages go; changes it made to the trip stay.", ok: "Clear", danger: true })) { state.chat = []; state.chatSummary = ""; state.chatSummarized = 0; chain = null; save(); render(); }
  };
  $("#cpCompact").onclick = () => compact(chat().length);
  panel().addEventListener("keydown", (e) => { if (e.key === "Escape" && window.innerWidth < 1180) setOpen(false); });
  // A change that was being applied when the page closed didn't finish.
  for (const t of chat()) if (t.change?.status === "applying") t.change.status = "offered";
  window.addEventListener("resize", () => { if (!panel().hidden) { markHeader(); mapModule.map?.invalidateSize(); document.body.classList.toggle("chat-cover", window.innerWidth <= 900); fitViewport(); } });
  window.visualViewport?.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("scroll", fitViewport);
  if (localStorage.getItem(OPEN_KEY)) setOpen(true);

  // Ideas & notes.
  const ideas = $<HTMLTextAreaElement>("#ideas");
  ideas.value = state.ideas || "";
  $<HTMLDetailsElement>("#ideasFold").open = !!state.ideas?.trim(); // folded away while empty
  ideas.addEventListener("input", () => { state.ideas = ideas.value; save(); });
}

/** After another trip is loaded or imported. */
export function refreshCompanion() {
  $<HTMLTextAreaElement>("#ideas").value = state.ideas || "";
  $<HTMLDetailsElement>("#ideasFold").open = !!state.ideas?.trim();
  chain = null;
  if (!panel().hidden) render();
}
