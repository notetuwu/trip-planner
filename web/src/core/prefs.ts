// The settings the page itself needs (from Settings → Planning), loaded when it starts. A phone on the home network
// can't read the computer's settings, so it keeps the defaults.
import { api } from "./dom";

export const prefs = { fixRounds: 1 };

export async function loadPrefs() {
  const s = await api<{ tune?: { fixRounds?: number } }>("/api/settings").catch(() => null);
  if (s?.tune?.fixRounds != null) prefs.fixRounds = s.tune.fixRounds;
}
