// Working on a trip together (a trip synced through a folder): who changed each part last and when (small "Lena · 5 min
// ago" marks by the stays, each day, the bookings, photos placed on the map…), and what changed while you had the trip
// open. Changes from others come in by themselves when you're not in the middle of typing; otherwise a note says they're
// waiting, with Update. Either way a note says who changed what, and Review lists it, with Undo for each change. When you
// and someone else changed the same thing, yours stays on screen and theirs is a click away (and kept as a copy).
import type { Change, Edit } from "../../../shared/edits";
import { changedParts, describePart, partLabel, partsOf, setPart } from "../../../shared/edits";
import { same } from "../../../shared/merge";
import { type AppState, state } from "../core/state";
import { closeOnBackdrop, esc } from "../core/dom";
import { icon } from "../core/icons";
import { syncStatus } from "./sync-client";

// ---- Who and when ----------------------------------------------------------------------------------------------------------
/** The change was made by this person (on this computer or another of theirs). */
export const isMine = (e: Edit | undefined) => !!e?.id && !!syncStatus?.editIds?.includes(e.id);
/** "you", or their name. */
export const whoOf = (e: Edit) => (isMine(e) ? "you" : e.by || "someone");
const initial = (name: string) => (name.trim()[0] || "?").toUpperCase();
/** A colour for a person, the same everywhere. */
const hue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
/** A small round mark with their initial. */
export const avatar = (e: Edit, cls = "") => `<span class="who-dot ${cls}" style="--h:${hue(e.by)}" aria-hidden="true">${esc(initial(e.by))}</span>`;

/** "just now", "5 min ago", "3 h ago", "yesterday", "Nov 24". */
export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(s > 300 * 86400 ? { year: "numeric" } : {}) });
}
const fullTime = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Several people may change this trip (it syncs through a folder): only then are the marks shown. */
export const shared = () => !!state.sync;

/** A part's last change. */
export const editOf = (key: string): Edit | undefined => state.edits?.[key];

/** "Lena · 5 min ago" for a part, or "" (not a shared trip, or not known). `verb` goes in its tooltip ("Changed",
 *  "Placed"). */
export function editChip(key: string, verb = "Changed") {
  const e = shared() ? editOf(key) : undefined;
  if (!e) return "";
  return `<span class="edit-chip${isMine(e) ? " mine" : ""}" title="${esc(`${verb} by ${whoOf(e)} · ${fullTime(e.at)}`)}">${avatar(e)}<span>${esc(isMine(e) ? "You" : e.by)} · ${esc(ago(e.at))}</span></span>`;
}
/** "Placed by Lena · 2 h ago", for a tooltip or caption ("" when not known). */
export function editLine(key: string, verb = "Changed") {
  const e = shared() ? editOf(key) : undefined;
  return e ? `${verb} by ${whoOf(e)} · ${ago(e.at)}` : "";
}

/** The newest change of the whole trip. */
export function lastEdit(): Edit | undefined {
  let best: Edit | undefined;
  for (const e of Object.values(state.edits || {})) if (!best || e.at > best.at) best = e;
  return best;
}

/** Fills the marks in the page's fixed places (the sidebar's headings: `data-edit="stays"`, or several parts at once:
 *  `data-edit="details places"`, which shows the newest). */
export function renderEditChips() {
  const hint = document.getElementById("ideasHint");
  if (hint) hint.textContent = shared() ? "shared with everyone on this trip, and the trip chat" : "only for you and the trip chat";
  for (const el of document.querySelectorAll<HTMLElement>("[data-edit]")) {
    const keys = el.dataset.edit!.split(/\s+/);
    const key = keys.filter((k) => editOf(k)).sort((a, b) => editOf(b)!.at - editOf(a)!.at)[0];
    el.innerHTML = key ? editChip(key) : "";
  }
}

// ---- What came in while the trip was open -----------------------------------------------------------------------------------
interface Pending {
  /** Each part's value before the first change that came in (to show what changed and to undo it). */
  before: Map<string, unknown>;
  /** Parts changed here and by someone else: theirs, waiting (yours is on screen). */
  clashes: Map<string, unknown>;
  from: "drive" | "window";
  at: number;
}
let pending: Pending | null = null;
/** Changes that have come in but aren't on screen yet (you were typing): who and when, and Update. */
let waiting: { edit?: Edit; take: () => void } | null = null;
let apply: (next: AppState) => Promise<void>;
let reveal: (key: string) => void;

/** The changes in a trip that just came in: `before` is the trip as it was on screen, `after` as it is now; `clashes`, the
 *  parts both changed, with the other side's version (yours stays). */
export function noteIncoming(before: AppState, after: AppState, from: "drive" | "window", clashes: Map<string, unknown> = new Map()) {
  waiting = null;
  const keys = changedParts(before, after).filter((k) => !clashes.has(k));
  if (!keys.length && !clashes.size) { drawBanner(); return; }
  const was = partsOf(before);
  if (!pending || pending.from !== from) pending = { before: new Map(), clashes: new Map(), from, at: Date.now() };
  for (const k of keys) if (!pending.before.has(k)) pending.before.set(k, was[k]);
  for (const [k, v] of clashes) { pending.clashes.set(k, v); if (!pending.before.has(k)) pending.before.set(k, was[k]); }
  pending.at = Date.now();
  drawBanner();
}

/** Changes are waiting to come in (you're typing): a note with who and Update. */
export function noteWaiting(edit: Edit | undefined, take: () => void) {
  waiting = { edit, take };
  drawBanner();
}
export const clearWaiting = () => { if (waiting) { waiting = null; drawBanner(); } };

/** The changes still to look at, newest stamp first, with photos together. */
function rows() {
  if (!pending) return [];
  const now = partsOf(state);
  // (A part changed back since, by Undo or by hand, has nothing to show.)
  const keys = [...pending.before.keys()].filter((k) => pending!.clashes.has(k) || !same(pending!.before.get(k), now[k]));
  const isPhoto = (k: string) => k.startsWith("photo:") && !pending!.clashes.has(k);
  const photos = keys.filter(isPhoto), others = keys.filter((k) => !isPhoto(k));
  return [...others.map((k) => ({ keys: [k] })), ...(photos.length ? [{ keys: photos }] : [])]
    .map((r) => ({ ...r, edit: r.keys.map(editOf).filter((e): e is Edit => !!e).sort((a, b) => b.at - a.at)[0] }));
}

/** Who made the changes, in words ("Lena", "Lena and Tom", "your other window"). */
function whoText(edits: (Edit | undefined)[]) {
  if (pending?.from === "window") return "Your other window";
  const names = [...new Set(edits.filter((e): e is Edit => !!e && !isMine(e)).map((e) => e.by))];
  if (!names.length) return edits.some(isMine) ? "You (on another computer)" : "Someone";
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function photoSummary(keys: string[]) {
  const now = partsOf(state), n = { placed: 0, moved: 0, reset: 0, "marked can't place": 0 } as Record<string, number>;
  for (const k of keys) { const w = describePart(k, pending!.before.get(k), now[k]); n[w] = (n[w] || 0) + 1; }
  return Object.entries(n).filter(([, c]) => c).map(([w, c]) => `${w} ${c} photo${c === 1 ? "" : "s"}`).join(", ") || `${keys.length} photo${keys.length === 1 ? "" : "s"}`;
}

const rowLabel = (keys: string[]) => (keys.length > 1 && keys[0].startsWith("photo:") ? "Photos on the map" : partLabel(keys[0], state));

function banner(): HTMLElement {
  let el = document.getElementById("collabBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "collabBanner"; el.className = "collab-banner"; el.setAttribute("role", "status"); el.hidden = true;
    // A popover: shown above the page's windows (the Photos window, Settings…), which a fixed note would be under.
    if ("showPopover" in el) el.popover = "manual";
    document.body.append(el);
    // The window it was in closed: back over the page.
    const made = el;
    document.addEventListener("close", (e) => {
      if (e.target instanceof HTMLDialogElement && e.target.contains(made)) { document.body.append(made); if (!made.hidden) drawBanner(); }
    }, true);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-cb-review]")) openReview();
      else if (t.closest("[data-cb-take]")) { const w = waiting; waiting = null; drawBanner(); w?.take(); }
      else if (t.closest("[data-cb-close]")) { pending = null; drawBanner(); }
    });
  }
  return el;
}

function drawBanner() {
  const el = banner();
  if (waiting) {
    const e = waiting.edit;
    el.className = "collab-banner waiting";
    el.innerHTML = `${e ? avatar(e) : icon("users")}<span class="cb-text"><b>${esc(e && !isMine(e) ? e.by : "Someone")}</b> changed this trip${e ? ` ${esc(ago(e.at))}` : ""}, while you had it open.</span>
      <button type="button" class="btn solid" data-cb-take title="Bring their changes in now (yours stay)">${icon("refresh")} Update</button>`;
    show(el);
    return;
  }
  const list = rows();
  if (!pending || !list.length) { el.hidden = true; if (el.popover) try { el.hidePopover(); } catch { /* not shown */ } pending = list.length ? pending : null; return; }
  const clashes = list.filter((r) => pending!.clashes.has(r.keys[0]));
  // Photos say what was done ("placed 9 photos"); other parts are "changed Day 3".
  const parts = list.filter((r) => !r.keys[0].startsWith("photo:")).map((r) => partLabel(r.keys[0], state));
  const photoRow = list.find((r) => r.keys[0].startsWith("photo:"));
  const changed = parts.length ? `changed ${parts.length <= 3 ? parts.join(", ") : `${parts.slice(0, 2).join(", ")} and ${parts.length - 2} more`}` : "";
  const what = [changed, photoRow ? photoSummary(photoRow.keys) : ""].filter(Boolean).join(" and ");
  const first = list.map((r) => r.edit).find((e) => e && !isMine(e)) || list[0].edit;
  el.className = `collab-banner${clashes.length ? " clash" : ""}`;
  el.innerHTML = `${first && pending.from === "drive" ? avatar(first) : icon("users")}
    <span class="cb-text"><b>${esc(whoText(list.map((r) => r.edit)))}</b> ${esc(what)}${clashes.length ? `. <b>You changed ${clashes.length === 1 ? "that" : "some of that"} too</b>: yours is kept` : ""}.</span>
    <button type="button" class="btn" data-cb-review>${icon("eye")} Review</button>
    <button type="button" class="icon-btn" data-cb-close title="OK" aria-label="Close">${icon("x")}</button>`;
  show(el);
}

/** On screen, over whatever window was opened last (shown again, it goes on top of the ones opened since). While a
 *  window is open (the Photos window, Settings…) everything outside it can't be clicked, so the note goes inside the
 *  topmost one, and back out when that closes. */
function show(el: HTMLElement) {
  const host = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => d.matches(":modal")).pop() || document.body;
  if (el.parentElement !== host) { if (el.popover) try { el.hidePopover(); } catch { /* not shown */ } host.append(el); }
  el.hidden = false;
  if (!el.popover) return;
  try { if (el.matches(":popover-open")) el.hidePopover(); el.showPopover(); } catch { /* an older browser: a fixed note */ }
}

/** The changes one by one: what changed, who and when, Show, and Undo (or, where you both changed it, Use theirs). */
function openReview() {
  if (!pending) return;
  const d = document.createElement("dialog");
  d.className = "keys-dialog collab-review";
  document.body.append(d);
  closeOnBackdrop(d);
  d.addEventListener("close", () => d.remove());
  const draw = () => {
    const list = rows();
    if (!list.length) { d.close(); drawBanner(); return; }
    const now = partsOf(state);
    d.innerHTML = `<form method="dialog" class="ask-form">
      <h3>${icon("users")} What changed</h3>
      <p class="ask-text">${pending!.from === "window" ? "From the trip in your other window or device." : "Changes from others that came in while you had the trip open. Undo puts a part back as it was before (for everyone)."}</p>
      <ul class="cr-list">${list.map((r, i) => {
        const k = r.keys[0], clash = pending!.clashes.has(k), e = r.edit;
        const detail = k.startsWith("photo:") ? photoSummary(r.keys) : describePart(k, pending!.before.get(k), now[k]);
        return `<li class="${clash ? "clash" : ""}">
          ${e ? avatar(e) : `<span class="who-dot" aria-hidden="true">${icon("users")}</span>`}
          <div class="cr-what"><b>${esc(rowLabel(r.keys))}</b>${detail ? `<span>${esc(detail)}</span>` : ""}
            <small>${e ? `${esc(whoOf(e) === "you" ? "You" : e.by)} · ${esc(ago(e.at))}` : ""}${clash ? `${e ? " · " : ""}you changed it too: yours is kept` : ""}</small></div>
          <div class="cr-acts">${canShow(k) ? `<button type="button" class="btn" data-cr-show="${i}">Show</button>` : ""}
            ${clash ? `<button type="button" class="btn" data-cr-theirs="${i}" title="Use their version of this instead of yours">Use theirs</button>`
              : `<button type="button" class="btn" data-cr-undo="${i}" title="Put this back as it was before">${icon("history")} Undo</button>`}</div>
        </li>`;
      }).join("")}</ul>
      <div class="ask-acts"><button type="button" class="btn" data-cr-clear title="Forget these changes (they stay in the trip)">Done</button></div>
    </form>`;
    d.querySelector<HTMLButtonElement>("[data-cr-clear]")!.onclick = () => { pending = null; d.close(); drawBanner(); };
    d.querySelectorAll<HTMLButtonElement>("[data-cr-show]").forEach((b) => { b.onclick = () => { d.close(); reveal(list[+b.dataset.crShow!].keys[0]); }; });
    d.querySelectorAll<HTMLButtonElement>("[data-cr-undo]").forEach((b) => {
      b.onclick = async () => {
        const r = list[+b.dataset.crUndo!], next = structuredClone(state) as AppState;
        if (!r.keys.every((k) => setPart(next, k, pending!.before.get(k)))) { b.disabled = true; b.title = "This can't be put back from here"; return; }
        await apply(next);
        for (const k of r.keys) pending?.before.delete(k);
        draw(); drawBanner();
      };
    });
    d.querySelectorAll<HTMLButtonElement>("[data-cr-theirs]").forEach((b) => {
      b.onclick = async () => {
        const k = list[+b.dataset.crTheirs!].keys[0], next = structuredClone(state) as AppState;
        if (!setPart(next, k, pending!.clashes.get(k))) { b.disabled = true; return; }
        await apply(next);
        pending?.clashes.delete(k); pending?.before.delete(k);
        draw(); drawBanner();
      };
    });
  };
  draw();
  d.showModal();
}

const canShow = (key: string) => key.startsWith("day:") || ["stays", "bookings", "places", "details", "ideas", "plan"].includes(key) || key.startsWith("photo:");

// ---- The trip's history (Changes) -------------------------------------------------------------------------------------------
/** The history, newest first, with changes made together to several photos (placing a group) as one. */
export function historyRows(log: Change[] = state.log || [], only?: (c: Change) => boolean): { changes: Change[]; first: Change }[] {
  const out: { changes: Change[]; first: Change }[] = [];
  for (const c of [...log].sort((a, b) => b.at - a.at)) {
    if (only && !only(c)) continue;
    const last = out[out.length - 1];
    if (last && c.key.startsWith("photo:") && last.first.key.startsWith("photo:") && (last.first.id || last.first.by) === (c.id || c.by) && Math.abs(last.first.at - c.at) < 2000) last.changes.push(c);
    else out.push({ changes: [c], first: c });
  }
  return out;
}

/** "Today", "Yesterday", "Mon, Nov 24": a heading for a day of changes. */
function dayHeading(at: number) {
  const d = new Date(at), today = new Date(), y = new Date(Date.now() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(d, today) ? "Today" : same(d, y) ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** What a row of the history says: its part, and what was done ("placed 12 photos"). */
function rowText(r: { changes: Change[]; first: Change }) {
  if (r.changes.length > 1) {
    const n = new Map<string, number>();
    for (const c of r.changes) n.set(c.what, (n.get(c.what) || 0) + 1);
    return { label: "Photos on the map", what: [...n].map(([w, k]) => `${w} ${k} photo${k === 1 ? "" : "s"}`).join(", ") };
  }
  return { label: partLabel(r.first.key, state), what: r.first.what };
}

/** Changes: the trip's latest changes, who made them and when, each with Show. */
export function openHistory() {
  const d = document.createElement("dialog");
  d.className = "keys-dialog collab-review collab-history";
  document.body.append(d);
  closeOnBackdrop(d);
  d.addEventListener("close", () => d.remove());
  let others = false;
  const draw = () => {
    const rowsAll = historyRows(state.log, others ? (c) => !isMine(c) : undefined).slice(0, 250);
    let day = "";
    const items = rowsAll.map((r, i) => {
      const { label, what } = rowText(r), h = dayHeading(r.first.at);
      const head = h !== day ? `<li class="ch-day">${esc((day = h))}</li>` : "";
      return `${head}<li>${avatar(r.first)}
        <div class="cr-what"><b>${esc(label)}</b>${what ? `<span>${esc(what)}</span>` : ""}<small>${esc(isMine(r.first) ? "You" : r.first.by)} · ${esc(clock(r.first.at))}</small></div>
        <div class="cr-acts">${canShow(r.first.key) ? `<button type="button" class="btn" data-ch-show="${i}">Show</button>` : ""}</div></li>`;
    }).join("");
    d.innerHTML = `<form method="dialog" class="ask-form">
      <h3>${icon("history")} Changes to this trip</h3>
      ${shared() ? `<div class="segs ch-filter"><button type="button" class="seg${others ? "" : " on"}" data-ch-who="all">Everyone</button><button type="button" class="seg${others ? " on" : ""}" data-ch-who="others">Others only</button></div>` : ""}
      ${items ? `<ul class="cr-list ch-list">${items}</ul>` : `<p class="ask-text">${others ? "Nobody else has changed this trip yet." : "No changes recorded yet. From now on every change is listed here, with who made it and when."}</p>`}
      <div class="ask-acts"><button type="submit" class="btn solid">Close</button></div>
    </form>`;
    d.querySelectorAll<HTMLButtonElement>("[data-ch-who]").forEach((b) => { b.onclick = () => { others = b.dataset.chWho === "others"; draw(); }; });
    d.querySelectorAll<HTMLButtonElement>("[data-ch-show]").forEach((b) => { b.onclick = () => { d.close(); reveal(rowsAll[+b.dataset.chShow!].first.key); }; });
  };
  draw();
  d.showModal();
}

// ---- Sync now, from anywhere ----------------------------------------------------------------------------------------------
let syncHook: ((button?: HTMLButtonElement) => Promise<void>) | null = null, canSyncHook: () => boolean = () => false;
/** The open trip syncs through a folder (so Sync now does something). */
export const canSyncNow = () => canSyncHook();
/** Sends what's waiting, looks at the folders and brings in others' changes (`button` spins meanwhile). */
export const syncNow = (button?: HTMLButtonElement) => syncHook?.(button) ?? Promise.resolve();

/** `apply`: puts a changed trip on screen and saves it; `show`: brings a part into view (a day, the stays…); `sync` and
 *  `canSync`: Sync now. Handed in to keep the imports one way. */
export function initCollab(o: { apply: (next: AppState) => Promise<void>; show: (key: string) => void; sync: (button?: HTMLButtonElement) => Promise<void>; canSync: () => boolean }) {
  apply = o.apply; reveal = o.show; syncHook = o.sync; canSyncHook = o.canSync;
  // The "5 min ago"s stay right.
  window.setInterval(() => { renderEditChips(); if (!banner().hidden) drawBanner(); }, 60_000);
}
