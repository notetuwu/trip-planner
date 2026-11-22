// The trip chat ("Ask about your trip"): questions about the trip on screen, answered by the selected model from the
// stays, the itinerary, the must-sees and the ideas notes. The conversation is kept with the trip (and saved with it).
// Also the Ideas & notes box: a scratchpad for the travelers that the chat can read, but that isn't sent with a plan.
import { $, esc } from "../core/dom";
import { addDays, fmtDate, todayIso } from "../core/format";
import { streamRequest } from "../core/progress";
import { save, session, state } from "../core/state";
import { mdLite } from "../itinerary/panels";

type Turn = { role: "me" | "ai"; text: string };
let running: AbortController | null = null;

const dialog = () => $<HTMLDialogElement>("#companionDialog");
const box = () => $<HTMLTextAreaElement>("#cpQ");
const MAX_TURNS = 40;

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
      out.push(`- ${x.city}: ${x.start ? `${fmtDate(x.start)} (${x.start}) to ${x.start ? addDays(x.start, x.nights) : ""}, ` : ""}${x.nights} night${x.nights === 1 ? "" : "s"}`
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

function render(pending?: string) {
  const log = $("#cpLog"), chat = state.chat || [];
  const bubble = (t: Turn) => `<div class="rc-msg ${t.role}">${t.role === "ai" ? mdLite(t.text) : esc(t.text)}</div>`;
  const starters = ["What's the plan for tomorrow?", "Where should we eat near our hotel?", "Which days are the busiest?", "What should we book ahead?", "Is anything closed on the days we're there?"];
  log.innerHTML = chat.map(bubble).join("")
    + (pending != null ? `<div class="rc-msg ai pending">${pending ? mdLite(pending) : "…"}</div>` : "")
    || `<p class="hint">Ask anything about your trip: what's on a day, where to eat, what to book, how to get somewhere, what to pack. It answers with the selected model, from your stays, the itinerary, your must-sees and your ideas.</p>
       <div class="cp-starters">${starters.map((q) => `<button type="button" class="chip-btn" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;
  log.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) => { b.onclick = () => { box().value = b.dataset.q!; ask(); }; });
  log.scrollTop = log.scrollHeight;
  idle();
}

function idle() {
  $<HTMLButtonElement>("#cpSend").disabled = !!running || !box().value.trim();
  $<HTMLButtonElement>("#cpCancel").hidden = !running;
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
  const history = (state.chat || []).slice(-12);
  state.chat = [...(state.chat || []), { role: "me" as const, text: question }].slice(-MAX_TURNS);
  save();
  box().value = ""; fit();
  running = new AbortController();
  render("");
  try {
    const { answer } = await streamRequest<{ answer: string }>("/api/companion", {
      model: state.model, question, history, context: tripContext(), today: todayIso(),
    }, (l) => {
      live.textContent = `${l.status}${l.tokens ? ` · ${l.tokens} tokens` : ""} · ${l.seconds} s`;
      if (l.reasoning) render(l.reasoning);
    }, running.signal);
    state.chat = [...state.chat, { role: "ai" as const, text: answer }].slice(-MAX_TURNS);
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

export function openCompanion() {
  dialog().show();
  render();
  fit();
  box().focus();
}

export function initCompanion() {
  $("#companionBtn").onclick = () => (dialog().open ? dialog().close() : openCompanion());
  $<HTMLFormElement>("#cpForm").onsubmit = (e) => { e.preventDefault(); ask(); };
  box().addEventListener("input", () => { fit(); idle(); });
  box().addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
  $(".companion-dialog .rc-box").onclick = (e) => { if (e.target === e.currentTarget) box().focus(); };
  $("#cpCancel").onclick = () => running?.abort();
  $("#cpClear").onclick = () => { if (!state.chat?.length || confirm("Clear the conversation?")) { state.chat = []; save(); render(); } };
  dialog().addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); dialog().close(); } });

  // Ideas & notes.
  const ideas = $<HTMLTextAreaElement>("#ideas");
  ideas.value = state.ideas || "";
  ideas.addEventListener("input", () => { state.ideas = ideas.value; save(); });
}

/** After another trip is loaded or imported. */
export function refreshCompanion() {
  $<HTMLTextAreaElement>("#ideas").value = state.ideas || "";
  if (dialog().open) render();
}
