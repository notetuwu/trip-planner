// The open trip, shared by every window and device using this planner: the app window, a browser tab, a phone on the
// home network. Each saves it on the computer (a moment after a change); when a window is looked at again, it takes a
// newer copy from there.
//
// A window may only replace the computer's copy when it has seen the latest one: it sends the time stamp of the copy it
// last sent or took (`base`), and the computer refuses when someone has saved since. Otherwise a tab left open from
// earlier, which saves its old trip as soon as anything in it updates (the weather, a map lookup), would overwrite the
// newer trip with the old one, and every other window would then take that.
//
// A window with changes of its own that weren't sent yet joins them with the newer copy (against the copy it last sent or
// took), so neither window's changes are lost; where both changed the same thing, its own stay and the other window's
// version is kept as a copy (Your trips → Recover), and Review offers it.
import { applyState } from "../saves/saves";
import { noteIncoming } from "../saves/collab";
import { mergeTrip, partOfPath, partsOf } from "../../../shared/edits";
import { same } from "../../../shared/merge";
import { api, toast } from "./dom";
import { type AppState, onSave, state } from "./state";

/** The time stamp of the computer's copy as of the last time this window sent it or took it. */
const SYNC_KEY = "trip-planner-v2-at";
const synced = () => Number(localStorage.getItem(SYNC_KEY)) || 0;
let timer: number | undefined, applying = false;
/** This window has changes the computer doesn't have yet. */
let dirty = false;
/** The trip as this window last sent it or took it (what its own changes are joined against); null until then. */
let base: AppState | null = null;

/** Sends the trip a moment after the last change (not on every keystroke). */
function pushSoon() {
  if (applying) return; // just taken from the computer: nothing new to send back
  dirty = true;
  clearTimeout(timer);
  timer = window.setTimeout(push, 1200);
}

async function push() {
  const at = Date.now(), was = synced(), body = JSON.stringify({ at, base: was, state });
  try {
    const r = await api<{ at: number; conflict?: boolean }>("/api/current", { method: "PUT", body });
    // Someone saved since this window last looked: this copy is out of date. It's joined with the newer one.
    if (r.conflict) { await pull(); return; }
    localStorage.setItem(SYNC_KEY, String(r.at));
    base = JSON.parse(body).state;
    // (Changed again while it was being sent: that goes with the next push.)
    if (JSON.stringify(state) === JSON.stringify(base)) dirty = false;
  } catch { /* offline: sent with the next change */ }
}

/** Takes a newer trip from the computer, if there is one (not while a plan is being made here). */
async function pull(quiet = false) {
  if (document.querySelector<HTMLElement>("#output")?.dataset.generating) return;
  try {
    const got = await api<{ at: number; state?: AppState }>(`/api/current?since=${synced()}`);
    if (got.state && got.at > synced()) {
      const before = structuredClone(state) as AppState, theirs = got.state, clashes = new Map<string, unknown>();
      let next = theirs, mine = false;
      // Changes here that were never sent: joined with the newer copy when this window knows what it last had.
      if (dirty && base && got.state.saveName === state.saveName) {
        const m = mergeTrip(base, state, theirs);
        next = m.value as AppState;
        const parts = partsOf(theirs);
        for (const p of m.clashes) { const k = partOfPath(p, theirs); clashes.set(k, parts[k]); }
        mine = !same(next, theirs);
        if (clashes.size) await api("/api/rescue", { method: "POST", body: JSON.stringify({ state: theirs }) }).catch(() => { /* kept if it can */ });
      }
      applying = true;
      // Changes here that were never sent and couldn't be joined (another trip opened there) are kept as a copy first
      // (Your trips → Recover).
      try { await applyState(next, { rescue: dirty && next === theirs, changes: mine }); } finally { applying = false; }
      localStorage.setItem(SYNC_KEY, String(got.at));
      base = theirs;
      dirty = false;
      // What was joined goes back to the computer, for the other windows.
      if (mine) pushSoon();
      if (!quiet) {
        if (before.saveName === state.saveName) noteIncoming(before, state, "window", clashes);
        else toast("Updated with the trip from your other window or device");
      }
    } else if (!got.at && !got.state) pushSoon(); // nothing on the computer yet: this trip is the first
    else if (!base && got.at) {
      // The computer's copy is the one this window last sent or took: what its changes are joined against. When this
      // window holds something else (changed just before it was closed, not sent yet), that goes now.
      const full = await api<{ at: number; state?: AppState }>("/api/current?since=0");
      if (full.state && full.at === synced()) { base = full.state; if (!same(base, state)) pushSoon(); }
    }
  } catch { /* the server is away (or an older one): carry on with this copy */ }
}

export function initSync() {
  onSave(pushSoon);
  pull(true);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); });
}
