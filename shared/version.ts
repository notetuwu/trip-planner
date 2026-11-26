// Comparing the app's versions ("3.29.0"), and what opens by itself when the app starts.

/** Above 0 when `a` is newer than `b`, below when older, 0 when the same. */
export function compareVersions(a: string, b: string) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** The oldest version that can be rolled back to: the oldest with a release to download (and able to update itself, so
 *  there's a way back). */
export const OLDEST_ROLLBACK = "3.5.2";
export const canRollBack = (to: string, from: string) => compareVersions(to, OLDEST_ROLLBACK) >= 0 && compareVersions(to, from) < 0;

/** On start: the quick-start guide (the first start ever), what's new (the first start of a newer version than any seen
 *  before), or nothing. `seen` is "" before any version was noted: then someone who has had the guide has just updated
 *  from a version that didn't note it. */
export function onStart(version: string, seen: string, hadGuide: boolean): "guide" | "news" | "nothing" {
  if (!hadGuide) return "guide";
  return !seen || compareVersions(version, seen) > 0 ? "news" : "nothing";
}
