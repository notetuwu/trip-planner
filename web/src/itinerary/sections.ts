// The itinerary's sections in a window of their own (from the toolbar and the small buttons by the title): the
// reasoning and the prompt, the key to what's what, holidays and events, the book-ahead checklist and the packing list.
// The phone file shows the same sections as fold-outs instead (see export/offline.ts).
import { $, esc } from "../core/dom";
import { icon, type IconName } from "../core/icons";
import { mapsName } from "../core/maps-links";
import { state } from "../core/state";
import { bookAheadHtml, refreshLinks, wireBookAhead } from "./book-ahead";
import { packingHtml, wirePacking } from "./packing";
import { promptBody, thoughtsBody } from "./panels";
import { eventsHtml } from "./summary";
import { balanceHtml } from "./balance-view";
import { selectDay } from "../map/days";

export type Section = "reasoning" | "prompt" | "key" | "events" | "ahead" | "packing" | "balance";

const dialog = () => $<HTMLDialogElement>("#sectionDialog");
let onClose: (() => void) | null = null;
let remeasure: number | undefined;

/** What's what in the plan and on the map. */
function keyHtml() {
  const row = (sample: string, text: string) => `<li><span class="key-sample">${sample}</span><span>${text}</span></li>`;
  return `<div class="key">
    <h4>Stops</h4>
    <ul>
      ${row(`<span class="key-dot listed"></span>`, "From your places: a saved list, or picked on the map.")}
      ${row(`<span class="key-dot"></span>`, "The planner's own pick: a real place from OpenStreetMap near the stay, or from its research.")}
      ${row(`<span class="key-dot must"></span><span class="must-tag">${icon("star")} must-see</span>`, "One of your must-sees.")}
      ${row(`<span class="n" style="--c:var(--accent)">3</span>`, "Its number on the map, in the day's colour.")}
      ${row(`<span class="book-badge">book ahead</span>`, "Sells out or needs a time slot: book before the trip (see Book ahead).")}
      ${row(`<span class="split-pill">⑂ split</span>`, "The group splits up for part of the day; each group's stops are side by side.")}
    </ul>
    <h4>Under a stop</h4>
    <ul>
      ${row(`<span class="key-link">Route</span>`, `Directions from the stop before, in ${esc(mapsName())} (Settings → General → Maps app).`)}
      ${row(`<span class="key-link">Find restaurants</span>`, "A meal without a particular place: what there is to eat around there.")}
      ${row(`<span class="key-leg">⇢ 1.2 km · 15 min walk</span>`, "How far it is from the stop before, along real paths and roads.")}
      ${row(`<span class="key-warn">${icon("clock")}</span>`, "Closed or closing at the planned time, by OpenStreetMap's opening hours: they can be out of date, so check before you go.")}
      ${row(`<span class="key-cost">~€12</span>`, "The planner's estimate of what it costs: not checked, prices may differ.")}
      ${row(`<span class="key-cost actual">✓ €10</span>`, "What you really paid (noted in Costs), in place of the estimate.")}
      ${row(`<span class="key-warn">${icon("warn")}</span>`, "The only place of that name is far from the day's town: probably a mix-up, pinned in town for now.")}
    </ul>
    <h4>Days</h4>
    <ul>
      ${row(`<span class="budget-pill">€80</span>`, "The day's estimated cost, within the budget.")}
      ${row(`<span class="budget-pill over">€140</span>`, "Over the day's budget.")}
      ${row(`<span class="key-icon">${icon("refresh")}</span>`, "Re-plan the day (or with <b>Re-plan this stay</b>, all days of a stay together).")}
    </ul>
    <h4>On the map</h4>
    <ul>
      ${row(`<span class="key-line solid"></span>`, "By road or rail, along the real route.")}
      ${row(`<span class="key-line dots"></span>`, "On foot.")}
      ${row(`<span class="key-line dashed"></span>`, "No route found (or by boat, cable car or plane): a straight line.")}
      ${row(`<span class="key-line stays"></span>`, "Between your stays, along the road or rail route.")}
      ${row(`<span class="key-line stays dashed"></span>`, "Between your stays, before the route is known (or by plane).")}
    </ul>
  </div>`;
}

const TITLES: Record<Section, [IconName, string]> = {
  reasoning: ["brain", "How the plan was made"], prompt: ["prompt", "Prompt sent to the model"], key: ["info", "What's what"],
  events: ["party", "Holidays & events"], ahead: ["ticket", "Book ahead"], packing: ["luggage", "Packing list"], balance: ["sliders", "How full each day is"],
};

/** A fold-out section as a plain block (no fold: the window is the section), with its heading line in the window's
 *  head instead. */
function unfolded(html: string) {
  const box = document.createElement("div");
  box.innerHTML = html;
  const d = box.querySelector("details");
  if (!d) return { html: "", hint: "" };
  const hint = d.querySelector(":scope > summary .hint")?.textContent || "";
  d.querySelector(":scope > summary")?.remove();
  const div = document.createElement("div");
  div.className = d.className.replace(/\bfold\b/, "").trim();
  div.append(...d.childNodes);
  d.replaceWith(div);
  return { html: box.innerHTML, hint };
}

function render(kind: Section) {
  const it = state.itinerary, meta = state.meta || {};
  if (!it) return;
  let body = "", hint = "";
  if (kind === "reasoning") {
    body = `${it.summary ? `<p class="sec-overview">${esc(it.summary)}</p>` : ""}<div class="thoughts-body">${thoughtsBody(meta.reasoning, meta.thinking, meta.lookups || [])}</div>`;
    hint = meta.lookups?.length ? `${meta.lookups.length} lookups online` : "";
  } else if (kind === "prompt") {
    body = `<div class="thoughts-body">${promptBody(meta.prompt || [])}</div>`;
    hint = `${(meta.prompt || []).length} part${(meta.prompt || []).length === 1 ? "" : "s"} · ${(meta.prompt || []).reduce((n, p) => n + p.text.length, 0).toLocaleString()} characters`;
  } else if (kind === "key") body = keyHtml();
  else if (kind === "balance") {
    const b = balanceHtml();
    body = b.html; hint = b.hint;
    // Routes still being measured: drawn again as they come in, while the window shows this.
    clearTimeout(remeasure);
    if (b.waiting) remeasure = window.setTimeout(() => { if (dialog().open && $("#sectionBody").classList.contains("sec-balance")) { const top = $("#sectionBody").scrollTop; render("balance"); $("#sectionBody").scrollTop = top; } }, 1500);
  }
  else ({ html: body, hint } = unfolded(kind === "events" ? eventsHtml(it) : kind === "ahead" ? bookAheadHtml(it) : packingHtml(it)));
  const [ic, title] = TITLES[kind];
  $("#sectionTitle").innerHTML = `${icon(ic)} ${esc(title)}`;
  $("#sectionMeta").textContent = hint;
  const el = $("#sectionBody");
  el.className = `section-body sec-${kind}`;
  el.innerHTML = body;
  if (kind === "ahead") { wireBookAhead(el); refreshLinks(); }
  if (kind === "balance") {
    for (const row of el.querySelectorAll<HTMLElement>("[data-bal-day]")) {
      const go = () => { dialog().close(); selectDay(+row.dataset.balDay!, { scroll: true }); };
      row.onclick = go;
      row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    }
  }
  if (kind === "packing") wirePacking(el, () => { render("packing"); el.dataset.changed = "1"; });
  // Ticking things off changes the counts in the toolbar: redrawn when the window closes.
  el.onchange = () => { el.dataset.changed = "1"; };
}

/** Opens a section in its window; `closed` runs afterwards when something in it was changed. */
export function openSection(kind: Section, closed?: () => void) {
  const dlg = dialog();
  render(kind);
  $("#sectionBody").dataset.changed = "";
  onClose = closed || null;
  dlg.onclose = () => { if ($("#sectionBody").dataset.changed && onClose) onClose(); };
  if (!dlg.open) dlg.showModal();
  $("#sectionBody").scrollTop = 0;
}
