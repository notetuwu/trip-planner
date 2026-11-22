// The trip chat: a panel beside the plan (Chat in the header) for questions about the trip on screen and for changes
// to it. Questions are answered by the selected model from the stays, the itinerary, the must-sees and the ideas notes.
// Asked for a change, it says what it will change and offers it: Apply changes the days it touches (or revises the whole
// plan) and the trip's setup (must-sees on the way or from a stay, the stays' day trips). Only the latest message has
// buttons; Undo on it puts back everything applied since the first change of the series. The conversation is kept with
// the trip (and saved with it).
// Also the Ideas & notes box: a scratchpad for the travelers that the chat can read, but that isn't sent with a plan.
// The chat never feeds into generation itself: only an applied change does, as its instruction.
import type { MustSeeHow } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { addDays, fmtDate, todayIso } from "../core/format";
import { icon } from "../core/icons";
import { showPicture } from "../core/lightbox";
import { streamRequest } from "../core/progress";
import { type AppState, keepPlace, save, session, setListPlaces, state } from "../core/state";
import { geocodePlaces, sameName } from "../geo/locate";
import { applyHow, renderChips } from "../places/chips";
import { renderStays } from "./stays";
import { geocodeItems } from "../geo/item-loc";
import { runGeneration } from "../generate/run";
import { mdLite } from "../itinerary/panels";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { map } from "../map/map";

type ChangeState = "offered" | "applying" | "applied" | "failed" | "skipped" | "undone";
interface TripOps { onTheWay?: string[]; fromStay?: string[]; removeDayTrips?: { stay: string; place: string }[]; addDayTrips?: { stay: string; place: string; mode: string }[]; addPlaces?: { name: string; where: string; must: boolean }[] }
interface PlanChange { days: number[]; request: string; trip?: TripOps; status?: ChangeState }
type Turn = { role: "me" | "ai"; text: string; images?: string[]; thinking?: string; thoughtSecs?: number; change?: PlanChange };
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
/** What a change touches, to put back on Undo. */
type Snapshot = Pick<AppState, "itinerary" | "stays" | "marks" | "how" | "kept" | "customPlaces">;
/** The changes applied one after another since the last Undo (by message index), and the trip from before the first:
 *  Undo on the latest puts all of them back. Only while the page is open. */
let chain: { snap: Snapshot; cards: number[] } | null = null;
const capture = (): Snapshot => structuredClone({ itinerary: state.itinerary, stays: state.stays, marks: state.marks, how: state.how, kept: state.kept, customPlaces: state.customPlaces });

const panel = () => $<HTMLElement>("#chatPanel");
const box = () => $<HTMLTextAreaElement>("#cpQ");
/** Compacting: once this many messages aren't covered by the summary, the older ones are summarized, keeping the
 *  most recent few as they are. */
const COMPACT_AT = 16, KEEP_RECENT = 6, HISTORY = 12;
const OPEN_KEY = "trip-planner-chat-open";

/** Everything the chat knows about the trip, as plain text. Long itineraries lose the descriptions first. */
export function tripContext(full = true): string {
  const s = state, it = s.itinerary, out: string[] = [];
  const stays = s.stays.filter((x) => x.city);
  out.push(`Travelers: ${s.travelers} · budget about ${s.dailyBudget} ${s.currency} per person a day (${s.dailyBudget * Math.max(1, s.travelers)} for the group; day costs in the plan are for the group) · pace: ${s.pace}`);
  if (s.interests) out.push(`Interests: ${s.interests}`);
  if (s.notes) out.push(`Their notes for the plan: ${s.notes}`);
  if (stays.length) {
    out.push("", "Stays:");
    for (const x of stays) {
      const trips = (x.dayTrips || []).map((d) => `${d.place} (${[d.mode, d.people ? `${d.people} of ${s.travelers} go` : ""].filter(Boolean).join(", ")})`).join(", ");
      out.push(`- ${x.city}: ${x.start ? `${fmtDate(x.start)} (${x.start}) to ${addDays(x.start, x.nights)}, ` : ""}${x.nights} night${x.nights === 1 ? "" : "s"}`
        + `${x.hotel ? `, staying at ${x.hotel}` : ""}${x.travel ? `, getting there by ${x.travel}` : ""}${trips ? `; day trips: ${trips}` : ""}`);
    }
  }
  const HOW: Record<string, string> = { way: "on the way between stays", stay: "from where they sleep" };
  const must = session.places.filter((p) => s.marks[p.title] === "must").map((p) => `${p.title}${s.how?.[p.title] ? ` (${HOW[s.how[p.title]]})` : ""}`);
  const skip = session.places.filter((p) => s.marks[p.title] === "skip").map((p) => p.title);
  if (must.length) out.push("", `Must-see places: ${must.join("; ")}`);
  if (skip.length) out.push(`Places they don't want: ${skip.join("; ")}`);
  if (s.ideas?.trim()) out.push("", "Their ideas & notes (brainstorming):", s.ideas.trim());
  if (it?.days?.length) {
    out.push("", `Itinerary${it.destination ? ` (${it.destination})` : ""}: ${it.summary || ""}`);
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
  const what = [c.request, ...opsLines(c.trip)].filter(Boolean).join("; ");
  const st = c.status === "applied" ? "applied" : c.status === "undone" ? "applied, then undone: the trip is as before it"
    : "offered but not applied (the traveler moved on; include it again if they still want it)";
  return `Change ${st}: ${what}`;
}

/** The setup changes in words. */
function opsLines(t?: TripOps) {
  if (!t) return [];
  return [
    ...(t.onTheWay || []).map((p) => `${p}: on the way between stays (no day trip)`),
    ...(t.fromStay || []).map((p) => `${p}: from where you sleep`),
    ...(t.removeDayTrips || []).map((x) => `No day trip to ${x.place}${x.stay ? ` from ${x.stay}` : ""}`),
    ...(t.addDayTrips || []).map((x) => `Day trip to ${x.place} from ${x.stay} (${x.mode})`),
    ...(t.addPlaces || []).map((x) => `Add ${x.name}${x.where ? ` (${x.where})` : ""} to your places${x.must ? " as a must-see" : ""}`),
  ];
}

/** The change card: what it changes, and (on the latest message only) Apply / Undo. Older cards just say how it went. */
function changeCard(c: PlanChange, k: number, latest: boolean) {
  const lines = opsLines(c.trip);
  const what = c.request
    ? (c.days.length ? `Changes ${dayList(c.days)} only, and only what you asked for; the other days stay exactly as they are.` : "Revises the whole plan, changing only what you asked for.")
    : "Changes the trip's setup; the day plans stay as they are.";
  const status = c.status || "offered";
  const inChain = chain?.cards.includes(k) ? chain.cards.length : 0;
  const actions = !latest
    ? (status === "applying" ? `<span class="hint">Changing the plan…</span>`
      : `<span class="hint">${status === "applied" ? `${icon("check")} Applied` : status === "undone" ? "Undone" : "Not applied"}</span>`)
    : status === "offered" || status === "skipped" ? `<button type="button" class="btn solid" data-apply="${k}">${icon("check")} Apply</button>${status === "offered" ? `<button type="button" class="link-btn" data-skip="${k}">Not now</button>` : `<span class="hint">Not applied.</span>`}`
    : status === "applying" ? `<span class="hint">Changing the plan… (progress in the itinerary)</span>`
    : status === "applied" ? `<span class="ok-text">${icon("check")} Done</span>${inChain ? `<button type="button" class="link-btn" data-undo="${k}">${inChain > 1 ? `Undo all ${inChain} changes` : "Undo"}</button>` : ""}`
    : status === "failed" ? `<span class="hint">Didn't work out.</span><button type="button" class="link-btn" data-apply="${k}">Try again</button>`
    : `<span class="hint">Undone: the trip is as it was.</span>`;
  return `<div class="cp-change${latest ? "" : " old"}"><div class="cp-change-what">${icon("route")} <span>${c.request ? `<b>${esc(c.request)}</b>` : ""}${lines.length ? `<ul class="cp-ops">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}<span class="hint">${what}</span></span></div><div class="cp-change-act">${actions}</div></div>`;
}

/** The model's thinking above its answer, folded like Claude's: "Thought for 12s" (open and live while it thinks). */
function thinkingHtml(thinking: string, label: string, open: boolean) {
  return `<details class="cp-think"${open ? " open" : ""}><summary>${icon("sparkles")}<span>${esc(label)}</span></summary><div class="cp-think-body">${mdLite(thinking)}</div></details>`;
}

function render(pending?: Pending) {
  const log = $("#cpLog");
  // Keep an opened "Thought for…" open across redraws.
  const opened = new Set([...log.querySelectorAll<HTMLDetailsElement>("details.cp-think[data-k]")].filter((d) => d.open).map((d) => d.dataset.k));
  const turns = chat(), last = turns.length - 1;
  // Buttons only on the very last message: once they write again, the conversation moves on from there.
  // Where the summary ends: a marker you can open to read it.
  const covered = state.chatSummarized || 0;
  const marker = (k: number) => (state.chatSummary && k === covered - 1
    ? `<details class="cp-summary"><summary>${icon("file")} Earlier messages summarized</summary><div class="cp-think-body">${mdLite(state.chatSummary)}</div></details>` : "");
  const pics = (t: Turn) => (t.images?.length ? `<div class="cp-pics">${t.images.map((src) => `<img src="${esc(src)}" alt="" data-zoom title="Click to see it big">`).join("")}</div>` : "");
  const bubble = (t: Turn, k: number) => t.role === "me" ? `${pics(t)}${t.text ? `<div class="rc-msg me">${esc(t.text)}</div>` : ""}${marker(k)}`
    : `<div class="rc-msg ai${k === last && pending == null && !["applied", "applying"].includes(t.change?.status || "") ? " last" : ""}">${t.thinking ? thinkingHtml(t.thinking, `Thought for ${t.thoughtSecs || 1}s`, opened.has(String(k))).replace('<details class="cp-think"', `<details class="cp-think" data-k="${k}"`) : ""}${mdLite(t.text)}${t.change ? changeCard(t.change, k, k === last && pending == null) : ""}${k === last && pending == null && !["applied", "applying"].includes(t.change?.status || "") ? `<div class="cp-msg-tools"><button type="button" class="link-btn" data-retry title="Ask again (a new answer replaces this one)">${icon("refresh")} Retry</button></div>` : ""}</div>${marker(k)}`;
  const hasPlan = !!state.itinerary?.days?.length;
  const starters = hasPlan
    ? ["What's the plan for tomorrow?", "What should we book ahead?", "Make the busiest day more relaxed", "Where should we eat near our hotel?", "Is anything closed on the days we're there?"]
    : ["Is this route realistic?", "What's the weather like then?", "What should we not miss?", "What should we pack?"];
  log.innerHTML = turns.map(bubble).join("")
    + (pending != null ? `<div class="rc-msg ai pending">${pending.thinking
      ? thinkingHtml(pending.thinking, pending.answering ? `Thought for ${Math.max(1, Math.round(((pending.until || Date.now()) - pending.since) / 1000))}s` : "Thinking…", !pending.answering) : ""}${pending.text
      ? mdLite(pending.text) : pending.answering || !pending.thinking ? `<span class="typing"><i></i><i></i><i></i></span>` : ""}${pending.status
      ? `<div class="cp-status">${esc(pending.status)}</div>` : ""}</div>` : "")
    + (notice && pending == null ? `<div class="cp-notice">${notice}</div>` : "")
    || `<div class="cp-empty"><div class="cp-empty-icon">${icon("chat")}</div>
        <p><b>Ask anything about your trip</b></p>
        <p class="hint">${hasPlan ? "What's on a day, where to eat, what to book, how to get around. Or ask for a change (“swap days 3 and 4”) and apply it from here." : "Questions about the places, the season or the route. Once there's a plan, you can change it from here too."}</p>
        <div class="cp-starters">${starters.map((q) => `<button type="button" class="chip-btn" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div></div>`;
  log.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => { b.onclick = () => { box().value = b.dataset.q!; ask(); }; });
  log.querySelectorAll<HTMLButtonElement>("[data-apply]").forEach((b) => { b.onclick = () => apply(+b.dataset.apply!); });
  log.querySelectorAll<HTMLButtonElement>("[data-skip]").forEach((b) => { b.onclick = () => setStatus(+b.dataset.skip!, "skipped"); });
  log.querySelectorAll<HTMLButtonElement>("[data-undo]").forEach((b) => { b.onclick = () => undo(); });
  log.scrollTop = log.scrollHeight;
  // The live thinking scrolls to its newest line.
  const live = log.querySelector<HTMLElement>(".pending .cp-think[open] .cp-think-body");
  if (live) live.scrollTop = live.scrollHeight;
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
  const c = chat()[k]?.change, it = state.itinerary;
  if (!c || !it) return;
  const now = capture(), snap = chain?.snap ?? now;
  setStatus(k, "applying");
  if (c.trip) { applyOps(c.trip); refreshAll(); }
  let ok = true;
  if (c.request) {
    const days = c.days.filter((d) => d >= 1 && d <= it.days.length).map((d) => d - 1);
    ok = await runGeneration(days.length ? { edit: { itinerary: state.itinerary!, days, request: c.request } } : { revise: { itinerary: state.itinerary!, request: c.request } });
    // The plan couldn't be changed: the setup goes back too, so nothing is half done.
    if (!ok && c.trip) { Object.assign(state, now); refreshAll(); }
  }
  if (ok) chain = { snap, cards: [...(chain?.cards || []), k] };
  setStatus(k, ok ? "applied" : "failed");
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
const turnText = (t: Turn) => ({ role: t.role, text: `${t.images?.length ? `(sent ${t.images.length} picture${t.images.length > 1 ? "s" : ""}) ` : ""}${t.text}${t.change ? `\n(${changeNote(t.change)})` : ""}` });

/** Summarizes the messages up to `upTo` (with the summary before them) so long chats stay quick; the messages stay on
 *  screen, with a marker where the summary ends. Without a summary (it failed), the chat just carries on. */
async function compact(upTo: number) {
  const from = state.chatSummarized || 0;
  if (upTo <= from || compacting) return;
  compacting = true;
  setNotice("Summarizing the earlier conversation…");
  try {
    const { summary } = await streamRequest<{ summary: string }>("/api/companion/compact", {
      model: chatModel(), turns: chat().slice(from, upTo).map(turnText), summary: state.chatSummary || "",
    }, (l) => { setNotice(esc(`${l.status}${l.tokens ? ` · ${l.tokens} tokens` : ""}`)); });
    state.chatSummary = summary; state.chatSummarized = upTo;
    save();
    notice = "";
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
  $<HTMLButtonElement>("#cpCompact").hidden = busy || chat().length - (state.chatSummarized || 0) < 4;
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
  if (chat().length - (state.chatSummarized || 0) > COMPACT_AT) await compact(chat().length - KEEP_RECENT);
  // What came before (after the summary), with the changes and how they went, so "undo that" or "and day 4 too" make sense.
  const history = chat().slice(Math.max(state.chatSummarized || 0, chat().length - HISTORY)).map(turnText);
  state.chat = [...chat(), { role: "me" as const, text: typed || (sent.length ? "" : question), ...(sent.length ? { images: sent.map((p) => p.thumb) } : {}) }];
  save();
  if (!again) { box().value = ""; fit(); }
  running = new AbortController();
  const pending: Pending = { text: "", thinking: "", since: 0, until: 0, answering: false };
  render(pending);
  try {
    const { answer, change, thinking, thoughtSecs } = await streamRequest<{ answer: string; change?: PlanChange; thinking?: string; thoughtSecs?: number }>("/api/companion", {
      model: chatModel(), question, history, summary: state.chatSummary || "", images: sent.map(({ type, data }) => ({ type, data })), context: tripContext(), today: todayIso(), days: state.itinerary?.days?.length || 0,
    }, (l) => {
      const status = `${l.status}${l.tokens ? ` · ${l.tokens} tokens` : ""} · ${l.seconds} s`;
      if (status !== pending.status) { pending.status = status; render(pending); }
      if (l.thinking && l.thinking !== pending.thinking) { pending.since ||= Date.now(); pending.thinking = l.thinking; render(pending); }
      if (l.reasoning && l.reasoning !== pending.text) { if (!pending.answering) pending.until = Date.now(); pending.answering = true; pending.text = l.reasoning; render(pending); }
    }, running.signal);
    state.chat = [...chat(), { role: "ai" as const, text: answer, ...(thinking ? { thinking, thoughtSecs } : {}), ...(change ? { change: { ...change, status: "offered" as const } } : {}) }];
  } catch (e) {
    const err = e as Error;
    notice = `${esc(err.name === "AbortError" ? "Stopped." : `Couldn't answer: ${err.message}`)} <button type="button" class="link-btn" data-retry>${icon("refresh")} Retry</button>`;
  } finally {
    running = null;
    save();
    render();
  }
}

/** Shows or hides the chat column (remembered in this browser); the map is told its size changed. */
function setOpen(open: boolean) {
  markHeader();
  panel().hidden = !open;
  document.body.classList.toggle("chat-open", open);
  $("#chatBtn").setAttribute("aria-pressed", String(open));
  localStorage.setItem(OPEN_KEY, open ? "1" : "");
  requestAnimationFrame(() => map?.invalidateSize());
  if (open) { render(); fit(); }
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
  box().addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
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
  $("#cpClear").onclick = () => {
    if (!chat().length || confirm("Clear the conversation?")) { state.chat = []; state.chatSummary = ""; state.chatSummarized = 0; chain = null; save(); render(); }
  };
  $("#cpCompact").onclick = () => compact(chat().length);
  panel().addEventListener("keydown", (e) => { if (e.key === "Escape" && window.innerWidth < 1180) setOpen(false); });
  // A change that was being applied when the page closed didn't finish.
  for (const t of chat()) if (t.change?.status === "applying") t.change.status = "offered";
  window.addEventListener("resize", () => { if (!panel().hidden) { markHeader(); map?.invalidateSize(); } });
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
