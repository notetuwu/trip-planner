// When the page last talked to the server and whether a plan is being made, so the packaged app can quit by itself
// a while after its window was closed (but never in the middle of a generation).

let lastSeen = Date.now(), pinged = false, busy = 0;

export function touch() { lastSeen = Date.now(); }
export function ping() { lastSeen = Date.now(); pinged = true; }

/** Runs fn as busy work: the app doesn't quit until it's done. */
export async function busyWhile<T>(fn: () => Promise<T>): Promise<T> {
  busy++;
  try { return await fn(); } finally { busy--; touch(); }
}

export const isBusy = () => busy > 0;

/** The page was open at some point and has been silent for `ms` with nothing running. */
export const idleFor = (ms: number) => pinged && busy === 0 && Date.now() - lastSeen > ms;
