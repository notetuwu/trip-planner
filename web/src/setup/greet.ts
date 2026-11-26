// What opens by itself when the app starts (on this computer; not on a phone): the quick-start guide the first time,
// and Settings → Updates once after an update. Other starts open nothing.
import { compareVersions, onStart } from "../../../shared/version";
import { api } from "../core/dom";
import { showUpdated } from "../settings/settings";
import { openQuickstart } from "./quickstart";

declare const __APP_VERSION__: string;
interface Seen { quickstartSeen?: boolean; seenVersion?: string }

export async function greet() {
  const s = await api<Seen>("/api/settings").catch(() => null);
  // No version field: an older server still answers, which couldn't note that the log was shown.
  if (!s || s.seenVersion === undefined) return;
  const what = onStart(__APP_VERSION__, s.seenVersion, !!s.quickstartSeen);
  // Noted first (never backwards, after going back to an older version): the log opens only once it's noted, so it
  // can't come back at every start.
  const noted = !s.seenVersion || compareVersions(__APP_VERSION__, s.seenVersion) > 0
    ? await api<Seen>("/api/settings", { method: "POST", body: JSON.stringify({ seenVersion: __APP_VERSION__ }) }).catch(() => null) : null;
  if (what === "guide") openQuickstart();
  else if (what === "news" && noted?.seenVersion === __APP_VERSION__) showUpdated(s.seenVersion);
}
