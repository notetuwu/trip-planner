// The trip chat: a panel beside the plan (Chat in the header) for questions about the trip on screen and for changes
// to it. Questions are answered by the selected model from the stays, the itinerary, the must-sees and the ideas notes.
// Asked for a change, it says what it will change and offers it: Apply re-plans that day (one day) or revises the plan
// (several days), and Undo puts the plan back. The conversation is kept with the trip (and saved with it).
// Also the Ideas & notes box: a scratchpad for the travelers that the chat can read, but that isn't sent with a plan.
// The chat never feeds into generation itself: only an applied change does, as its instruction.
import type { Itinerary } from "../../../shared/types";
import { $, esc } from "../core/dom";
import { addDays, fmtDate, todayIso } from "../core/format";
import { icon } from "../core/icons";
import { streamRequest } from "../core/progress";
import { save, session, state } from "../core/state";
import { geocodeItems } from "../geo/item-loc";
import { runGeneration } from "../generate/run";
import { mdLite } from "../itinerary/panels";
import { renderItinerary } from "../itinerary/render";
import { drawMap } from "../map/draw";
import { map } from "../map/map";

type ChangeState = "offered" | "applying" | "applied" | "failed" | "skipped" | "undone";
interface PlanChange { days: number[]; request: string; status?: ChangeState }
type Turn = { role: "me" | "ai"; text: string; change?: PlanChange };

let running: AbortController | null = null;
/** The plan before each applied change (by message index), for Undo. Only while the page is open. */
const before = new Map<number, Itinerary>();

const panel = () => $<HTMLElement>("#chatPanel");
const box = () => $<HTMLTextAreaElement>("#cpQ");
const MAX_TURNS = 40;
const OPEN_KEY = "trip-planner-chat-open";

/** Everything the chat knows about the trip, as plain text. Long itineraries lose the descriptions first. */
export function tripContext(full = true): string {
  const s = state, it = s.itinerary, out: string[] = [];
  const stays = s.stays.filter((x) => x.city);
  out.push(`Travelers: ${s.travelers} · budget about ${s.dailyBudget} ${s.currency} a day · pace: ${s.pace}`);
  if (s.interests) out.push(`Interests: ${s.interests}`);
  if (s.notes) out.push(`Their notes for the plan: ${s.notes}`);
  if (stays.length) {
    out.push("", "Stays:");
    for (const x of stays) {
      const trips = (x.dayTrips || []).map((d) => `${d.place} (${d.mode})`).join(", ");
      out.push(`- ${x.city}: ${x.start ? `${fmtDate(x.start)} (${x.start}) to ${addDays(x.start, x.nights)}, ` : ""}${x.nights} night${x.nights === 1 ? "" : "s"}`
        + `${x.hotel ? `, staying at ${x.hotel}` : ""}${x.travel ? `, getting there by ${x.travel}` : ""}${trips ? `; day trips: ${trips}` : ""}`);
    }
  }
  const must = session.places.filter((p) => s.marks[p.title] === "must").map((p) => p.title);
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

/** What the change card says and offers, by where it's at. */
function changeCard(c: PlanChange, k: number) {
  const what = c.days.length === 1 ? `Re-plans day ${c.days[0]}; the other days stay as they are.` : `Revises the plan (${dayList(c.days)}).`;
  const status = c.status || "offered";
  const actions = status === "offered" ? `<button type="button" class="btn solid" data-apply="${k}">${icon("check")} Apply</button><button type="button" class="link-btn" data-skip="${k}">Not now</button>`
    : status === "applying" ? `<span class="hint">Changing the plan… (progress in the itinerary)</span>`
    : status === "applied" ? `<span class="ok-text">${icon("check")} Done</span>${before.has(k) ? `<button type="button" class="link-btn" data-undo="${k}">Undo</button>` : ""}`
    : status === "failed" ? `<span class="hint">Didn't work out.</span><button type="button" class="link-btn" data-apply="${k}">Try again</button>`
    : status === "undone" ? `<span class="hint">Undone: the plan is as it was.</span>`
    : `<span class="hint">Not applied.</span><button type="button" class="link-btn" data-apply="${k}">Apply</button>`;
  return `<div class="cp-change"><div class="cp-change-what">${icon("route")} <span><b>${esc(c.request)}</b><br><span class="hint">${what}</span></span></div><div class="cp-change-act">${actions}</div></div>`;
}

function render(pending?: string) {
  const log = $("#cpLog");
  const bubble = (t: Turn, k: number) => t.role === "me" ? `<div class="rc-msg me">${esc(t.text)}</div>`
    : `<div class="rc-msg ai">${mdLite(t.text)}${t.change ? changeCard(t.change, k) : ""}</div>`;
  const hasPlan = !!state.itinerary?.days?.length;
  const starters = hasPlan
    ? ["What's the plan for tomorrow?", "What should we book ahead?", "Make the busiest day more relaxed", "Where should we eat near our hotel?", "Is anything closed on the days we're there?"]
    : ["Is this route realistic?", "What's the weather like then?", "What should we not miss?", "What should we pack?"];
  log.innerHTML = chat().map(bubble).join("")
    + (pending != null ? `<div class="rc-msg ai pending">${pending ? mdLite(pending) : `<span class="typing"><i></i><i></i><i></i></span>`}</div>` : "")
    || `<div class="cp-empty"><div class="cp-empty-icon">${icon("chat")}</div>
        <p><b>Ask anything about your trip</b></p>
        <p class="hint">${hasPlan ? "What's on a day, where to eat, what to book, how to get around. Or ask for a change (“swap days 3 and 4”) and apply it from here." : "Questions about the places, the season or the route. Once there's a plan, you can change it from here too."}</p>
        <div class="cp-starters">${starters.map((q) => `<button type="button" class="chip-btn" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div></div>`;
  log.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => { b.onclick = () => { box().value = b.dataset.q!; ask(); }; });
  log.querySelectorAll<HTMLButtonElement>("[data-apply]").forEach((b) => { b.onclick = () => apply(+b.dataset.apply!); });
  log.querySelectorAll<HTMLButtonElement>("[data-skip]").forEach((b) => { b.onclick = () => setStatus(+b.dataset.skip!, "skipped"); });
  log.querySelectorAll<HTMLButtonElement>("[data-undo]").forEach((b) => { b.onclick = () => undo(+b.dataset.undo!); });
  log.scrollTop = log.scrollHeight;
  idle();
}

function setStatus(k: number, status: ChangeState) {
  const t = chat()[k];
  if (t?.change) { t.change.status = status; save(); render(); }
}

/** Applies a change: one day is re-planned on its own; anything bigger revises the whole plan. */
async function apply(k: number) {
  const c = chat()[k]?.change, it = state.itinerary;
  if (!c || !it) return;
  const snapshot = structuredClone(it);
  setStatus(k, "applying");
  const one = c.days.length === 1 && c.days[0] <= it.days.length;
  const ok = await runGeneration(one ? { redoDay: { itinerary: it, day: c.days[0] - 1, request: c.request } } : { revise: { itinerary: it, request: c.request } });
  if (ok) before.set(k, snapshot);
  setStatus(k, ok ? "applied" : "failed");
}

function undo(k: number) {
  const it = before.get(k);
  if (!it) return;
  state.itinerary = it;
  before.delete(k);
  save();
  renderItinerary(); drawMap({ fit: false }); geocodeItems();
  setStatus(k, "undone");
}

/** The send button, or while it answers, a stop button in its place (like Claude Code's). */
function idle() {
  const send = $<HTMLButtonElement>("#cpSend"), busy = !!running;
  if (send.classList.contains("stop") !== busy) {
    send.classList.toggle("stop", busy);
    send.innerHTML = icon(busy ? "stop" : "arrowUp");
    send.title = busy ? "Stop" : "Send (Enter) · new line with Shift+Enter";
  }
  send.disabled = !busy && !box().value.trim();
  const model = $<HTMLSelectElement>("#model").selectedOptions[0]?.textContent?.trim() || "";
  $("#cpModel").textContent = model ? `· ${model}` : "";
}

function fit() {
  const b = box();
  b.style.height = "auto";
  b.style.height = `${Math.min(b.scrollHeight, 180)}px`;
}

async function ask() {
  const question = box().value.trim();
  if (!question || running) return;
  const live = $("#cpLive");
  // What came before, with the changes that were applied, so "undo that" or "and day 4 too" make sense.
  const history = chat().slice(-12).map((t) => ({ role: t.role, text: t.change ? `${t.text}\n(Change offered: ${t.change.request}; ${t.change.status || "offered"})` : t.text }));
  state.chat = [...chat(), { role: "me" as const, text: question }].slice(-MAX_TURNS);
  save();
  box().value = ""; fit();
  running = new AbortController();
  render("");
  try {
    const { answer, change } = await streamRequest<{ answer: string; change?: PlanChange }>("/api/companion", {
      model: state.model, question, history, context: tripContext(), today: todayIso(), days: state.itinerary?.days?.length || 0,
    }, (l) => {
      live.textContent = `${l.status}${l.tokens ? ` · ${l.tokens} tokens` : ""} · ${l.seconds} s`;
      if (l.reasoning) render(l.reasoning);
    }, running.signal);
    state.chat = [...chat(), { role: "ai" as const, text: answer, ...(change ? { change: { ...change, status: "offered" as const } } : {}) }].slice(-MAX_TURNS);
    live.textContent = "";
  } catch (e) {
    const err = e as Error;
    live.textContent = err.name === "AbortError" ? "Stopped." : `Couldn't answer: ${err.message}`;
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
  $("#cpClose").onclick = () => setOpen(false);
  $<HTMLFormElement>("#cpForm").onsubmit = (e) => { e.preventDefault(); if (running) running.abort(); else ask(); };
  box().addEventListener("input", () => { fit(); idle(); });
  box().addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
  $("#chatPanel .rc-box").onclick = (e) => { if (e.target === e.currentTarget) box().focus(); };
  $("#cpClear").onclick = () => { if (!chat().length || confirm("Clear the conversation?")) { state.chat = []; before.clear(); save(); render(); } };
  panel().addEventListener("keydown", (e) => { if (e.key === "Escape" && window.innerWidth < 1180) setOpen(false); });
  // A change that was being applied when the page closed didn't finish.
  for (const t of chat()) if (t.change?.status === "applying") t.change.status = "offered";
  window.addEventListener("resize", () => { if (!panel().hidden) { markHeader(); map?.invalidateSize(); } });
  if (localStorage.getItem(OPEN_KEY)) setOpen(true);

  // Ideas & notes.
  const ideas = $<HTMLTextAreaElement>("#ideas");
  ideas.value = state.ideas || "";
  ideas.addEventListener("input", () => { state.ideas = ideas.value; save(); });
}

/** After another trip is loaded or imported. */
export function refreshCompanion() {
  $<HTMLTextAreaElement>("#ideas").value = state.ideas || "";
  before.clear();
  if (!panel().hidden) render();
}
