// The open trip, shared by every window and device using this planner: the app window, a browser tab, a phone on the
// home network. Each saves it on the computer (a moment after a change); when a window is looked at again, it takes a
// newer copy from there.
//
// A window may only replace the computer's copy when it has seen the latest one: it sends the time stamp of the copy it
// last sent or took (`base`), and the computer refuses when someone has saved since. Otherwise a tab left open from
// earlier, which saves its old trip as soon as anything in it updates (the weather, a map lookup), would overwrite the
// newer trip with the old one, and every other window would then take that.
import { applyState } from "../saves/saves";
import { api, toast } from "./dom";
import { type AppState, onSave, state } from "./state";

/** The time stamp of the computer's copy as of the last time this window sent it or took it. */
const SYNC_KEY = "trip-planner-v2-at";
const synced = () => Number(localStorage.getItem(SYNC_KEY)) || 0;
let timer: number | undefined, applying = false;
/** This window has changes the computer doesn't have yet. */
let dirty = false;

/** Sends the trip a moment after the last change (not on every keystroke). */
function pushSoon() {
  if (applying) return; // just taken from the computer: nothing new to send back
  dirty = true;
  clearTimeout(timer);
  timer = window.setTimeout(push, 1200);
}

async function push() {
  const at = Date.now(), base = synced();
  try {
    const r = await api<{ at: number; conflict?: boolean }>("/api/current", { method: "PUT", body: JSON.stringify({ at, base, state }) });
    // Someone saved since this window last looked: this copy is out of date. It takes the newer one (a copy of this one is kept).
    if (r.conflict) { await pull(); return; }
    localStorage.setItem(SYNC_KEY, String(r.at));
    dirty = false;
  } catch { /* offline: sent with the next change */ }
}

/** Takes a newer trip from the computer, if there is one (not while a plan is being made here). */
async function pull(quiet = false) {
  if (document.querySelector<HTMLElement>("#output")?.dataset.generating) return;
  try {
    const got = await api<{ at: number; state?: AppState }>(`/api/current?since=${synced()}`);
    if (got.state && got.at > synced()) {
      applying = true;
      // Changes here that were never sent are kept as a copy first (Your trips → Recover).
      try { await applyState(got.state, { rescue: dirty }); } finally { applying = false; }
      localStorage.setItem(SYNC_KEY, String(got.at));
      dirty = false;
      if (!quiet) toast("Updated with the trip from your other window or device");
    } else if (!got.at && !got.state) pushSoon(); // nothing on the computer yet: this trip is the first
  } catch { /* the server is away (or an older one): carry on with this copy */ }
}

export function initSync() {
  onSave(pushSoon);
  pull(true);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); });
}
