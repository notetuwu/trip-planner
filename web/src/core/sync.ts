// The open trip, shared by every window and device using this planner: the app window, a browser tab, a phone on the
// home network. Each saves it on the computer (a moment after a change); when a window is looked at again, it takes a
// newer copy from there. The newest change wins.
import { applyState } from "../saves/saves";
import { api, toast } from "./dom";
import { type AppState, onSave, state } from "./state";

const AT_KEY = "trip-planner-v2-at";
const localAt = () => Number(localStorage.getItem(AT_KEY)) || 0;
let timer: number | undefined, applying = false;

/** Sends the trip a moment after the last change (not on every keystroke). */
function pushSoon() {
  if (applying) return; // just taken from the computer: nothing new to send back
  const at = Date.now();
  localStorage.setItem(AT_KEY, String(at));
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    api("/api/current", { method: "PUT", body: JSON.stringify({ at, state }) }).catch(() => { /* offline: sent with the next change */ });
  }, 1200);
}

/** Takes a newer trip from the computer, if there is one (not while a plan is being made here). */
async function pull(quiet = false) {
  if (document.querySelector<HTMLElement>("#output")?.dataset.generating) return;
  try {
    const got = await api<{ at: number; state?: AppState }>(`/api/current?since=${localAt()}`);
    if (got.state && got.at > localAt()) {
      applying = true;
      try { await applyState(got.state); } finally { applying = false; }
      localStorage.setItem(AT_KEY, String(got.at));
      if (!quiet) toast("Updated with the trip from your other window or device");
    } else if (!got.at && !got.state) pushSoon(); // nothing on the computer yet: this trip is the first
  } catch { /* the server is away (or an older one): carry on with this copy */ }
}

export function initSync() {
  onSave(pushSoon);
  pull(true);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); });
}
