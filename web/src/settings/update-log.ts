// The update log (Settings → Updates): what changed in every version up to this one, on a timeline, newest first. Each
// version folds out; the newest, or those new since the last update, start unfolded. The list is part of the app
// ("virtual:changelog", made from the commit messages when it's built), so it's there offline.
import type { Change, Release } from "../../../shared/types";
import { canRollBack, compareVersions } from "../../../shared/version";
import { askConfirm } from "../core/ask";
import { $, esc } from "../core/dom";
import { ext, icon } from "../core/icons";
import { install } from "../core/update";

declare const __APP_VERSION__: string;
const RELEASES = "https://github.com/notetuwu/trip-planner/releases";

let log: Release[] | null = null, box: HTMLElement | null = null;
/** The version updated from, while its newer ones are marked: null = no update, "" = not known (only this one is new). */
let since: string | null = null;

/** How this copy can go back to an older version: it installs it ("install", the Windows app), the version is
 *  downloaded by hand ("download", the macOS and Linux app), or it can't (null: running from the source, or a phone). */
export type Rollback = "install" | "download" | null;
let rollback: Rollback = null;

const rollButton = (v: string) => !rollback || !canRollBack(v, __APP_VERSION__) ? ""
  : rollback === "install" ? `<button type="button" class="btn log-roll" data-rollback="${esc(v)}">${icon("undo")} Roll back to ${esc(v)}</button>`
    : `<a class="btn log-roll" href="${RELEASES}/tag/v${esc(v)}" target="_blank" rel="noopener">${icon("download")} Download ${esc(v)}${ext()}</a>`;

async function rollBack(v: string) {
  const sure = await askConfirm({
    title: `Roll back to ${v}?`, ok: "Roll back", danger: true,
    text: `Trip Planner ${v} is downloaded and installed over ${__APP_VERSION__}, and the app restarts.\n\nAn older version may not know newer things in your trips and settings, and can drop them when it saves (synced trips too). A copy of your trips, place lists and settings is kept first, in the "backups" folder where your data is.\n\nTo come back, use Update now in the bar the older version shows at the top.`,
  });
  if (!sure) return;
  $<HTMLDialogElement>("#settingsDialog").close();
  install({ newer: false, current: __APP_VERSION__, latest: v, notesUrl: `${RELEASES}/tag/v${v}` }, true);
}

const isNew = (v: string) => since !== null && (since ? compareVersions(v, since) > 0 && compareVersions(v, __APP_VERSION__) <= 0 : v === __APP_VERSION__);
const date = (iso: string) => iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";

const points = (c: Change) => `${c.intro ? `<p>${esc(c.intro)}</p>` : ""}${c.groups.map((g) =>
  `${g.head ? `<h5>${esc(g.head)}</h5>` : ""}<ul>${g.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`).join("")}`;

function entry(r: Release, open: boolean) {
  const one = r.changes.length === 1;
  const marks = `${isNew(r.version) ? " new" : ""}${r.version === __APP_VERSION__ ? " current" : ""}`;
  const head = `<span class="log-top"><span class="log-version">${esc(r.version)}</span>${isNew(r.version) ? `<span class="log-badge new">New</span>` : ""}${r.version === __APP_VERSION__ ? `<span class="log-badge">Installed</span>` : ""}<span class="log-date">${date(r.date)}</span></span>
    <span class="log-title">${esc(r.changes[0]?.subject || "Small fixes")}${r.changes.length > 1 ? ` <span class="hint">and ${r.changes.length - 1} more</span>` : ""}</span>`;
  // A single change is already named in the head.
  const body = r.changes.map((c) => `${one ? "" : `<h4>${esc(c.subject)}</h4>`}${points(c)}`).join("");
  const roll = rollButton(r.version);
  return `<li class="log-item${marks}">${body
    ? `<details data-version="${esc(r.version)}"${open ? " open" : ""}><summary><span class="log-head">${head}</span>${icon("chevronDown")}</summary><div class="log-body">${body}${roll ? `<div class="log-acts">${roll}</div>` : ""}</div></details>`
    : `<div class="log-plain"><span class="log-head">${head}</span>${roll}</div>`}</li>`;
}

/** `keep`: a redraw of a list that's on screen, which stays folded as it is. */
function draw(keep = false) {
  if (!box) return;
  const all = log || [];
  const fresh = all.filter((r) => isNew(r.version));
  const unfolded = new Set(keep ? [...box.querySelectorAll<HTMLElement>("details[open]")].map((d) => d.dataset.version!) : (fresh.length ? fresh : all.slice(0, 1)).map((r) => r.version));
  box.innerHTML = `
    <div class="log-bar"><b class="card-title">Update log</b>${all.length ? `<span class="hint">${all.length} versions</span><button type="button" class="link-btn" data-log-all></button>` : ""}</div>
    ${!log ? `<p class="hint">Loading…</p>` : all.length ? `<ol class="log">${all.map((r) => entry(r, unfolded.has(r.version))).join("")}</ol>`
      : `<p class="hint">This copy was built without its version history. <a href="${RELEASES}" target="_blank" rel="noopener">See all releases on GitHub${ext()}</a></p>`}`;
  const button = box.querySelector<HTMLButtonElement>("[data-log-all]");
  if (!button) return;
  const folds = [...box.querySelectorAll("details")];
  const allOpen = () => folds.every((d) => d.open);
  const label = () => { button.textContent = allOpen() ? "Fold all" : "Unfold all"; };
  button.onclick = () => { const open = !allOpen(); for (const d of folds) d.open = open; label(); };
  for (const d of folds) d.addEventListener("toggle", label);
  label();
}

/** Marks the versions newer than `from` (the one updated from) as new, and unfolds them. */
export function markNewSince(from: string) {
  since = from;
  draw();
}

/** Shows the roll back buttons this copy can offer. */
export function setRollback(how: Rollback) {
  if (how === rollback) return;
  rollback = how;
  draw(!!log);
}

/** The log's card: made once, then the same one, so what's unfolded stays unfolded. */
export function updateLog() {
  if (box) return box;
  box = document.createElement("div");
  box.className = "set-card log-card";
  box.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-rollback]");
    if (b) rollBack(b.dataset.rollback!);
  });
  draw();
  import("virtual:changelog").then((m) => { log = m.default; draw(); }).catch(() => { log = []; draw(); });
  return box;
}
