// Which app windows are open and whether a plan is being made, so the packaged app can quit by itself once its last
// window is closed (but never in the middle of a generation). Each page checks in every 20 s with its own id and says
// goodbye when it closes; a page that vanished without a goodbye (e.g. the browser crashed) counts as gone after 12 h.

const pages = new Map<string, number>(); // page id -> last check-in
const started = Date.now();
let lastSeen = Date.now(), lastGoodbye = 0, everOpened = false, busy = 0;
// Long: browsers put background tabs to sleep (no check-ins) without closing them; only a goodbye means "closed".
const STALE = 12 * 3600 * 1000;

export function touch() { lastSeen = Date.now(); }

export function ping(id: string) {
  lastSeen = Date.now(); everOpened = true;
  pages.set(id || "anonymous", Date.now());
}

export function goodbye(id: string) {
  pages.delete(id || "anonymous");
  lastGoodbye = Date.now();
}

export const openWindows = () => pages.size;
/** A plan is being made right now (background work waits, so it doesn't compete with it). */
export const working = () => busy > 0;

/** Runs fn as busy work: the app doesn't quit until it's done. */
export async function busyWhile<T>(fn: () => Promise<T>): Promise<T> {
  busy++;
  try { return await fn(); } finally { busy--; touch(); }
}

/** Every window that was open is gone (closed for `graceMs`, so a reload doesn't count) and nothing is running. */
export function allClosed(graceMs: number) {
  const now = Date.now();
  for (const [id, at] of pages) if (now - at > STALE) pages.delete(id);
  // No window ever came (the browser didn't open, or it was closed during an update's restart): give up after 10 min.
  if (!everOpened) return busy === 0 && now - started > 10 * 60 * 1000;
  if (busy > 0 || pages.size > 0) return false;
  return now - Math.max(lastGoodbye, lastSeen) > graceMs;
}
