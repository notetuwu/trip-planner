// The settings the page itself needs: from Settings → Planning (fix rounds) and Settings → General (units and formats,
// map defaults, start-up and saving, what a new trip starts with). They're kept on the computer the planner runs on,
// and copied here so the page can use them the moment it starts; a phone on the home network can't read the
// computer's settings, so it uses that copy or the defaults.
import { api } from "./dom";

export interface AppPrefs {
  units: "km" | "mi";
  clock: "24" | "12";
  dates: "auto" | "dmy" | "mdy";
  mapNames: "local" | "english";
  showPlaces: boolean;
  showRoutes: boolean;
  mapsApp: "google" | "apple" | "bing";
  startWith: "last" | "new";
  autoSave: boolean;
  /** A saved trip that's open is kept up to date by itself, a few seconds after each change. */
  liveSave: boolean;
  /** Look the plan's places up on Wikimedia for the trip preview's pictures (off unless switched on). */
  placePictures: boolean;
  /** Download the map's transport lines around the trip's stays in the background, and how far around each (km). */
  linesDownload: boolean;
  linesRadius: number;
  newTrip: { currency: string; travelers: number; dailyBudget: number; pace: string };
}

export const APP_DEFAULTS: AppPrefs = {
  units: "km", clock: "24", dates: "auto", mapNames: "local", showPlaces: true, showRoutes: true, mapsApp: "google", startWith: "last", autoSave: false, liveSave: true, placePictures: false,
  linesDownload: true, linesRadius: 10,
  newTrip: { currency: "EUR", travelers: 1, dailyBudget: 100, pace: "balanced (3-5 stops per day)" },
};

const CACHE_KEY = "trip-planner-app-prefs";
const cached = (): Partial<AppPrefs> => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { return {}; } };

export const prefs = { fixRounds: 1, app: { ...APP_DEFAULTS, ...cached(), newTrip: { ...APP_DEFAULTS.newTrip, ...(cached().newTrip || {}) } } as AppPrefs };

const listeners: (() => void)[] = [];
/** Called when Settings → General changes (the page redraws in the new units and formats). */
export const onAppPrefs = (fn: () => void) => { listeners.push(fn); };

/** Takes the settings from the server's answer (on start, and after each change in Settings). */
export function setPrefs(s: { tune?: { fixRounds?: number }; app?: AppPrefs } | null) {
  if (s?.tune?.fixRounds != null) prefs.fixRounds = s.tune.fixRounds;
  if (s?.app && JSON.stringify(s.app) !== JSON.stringify(prefs.app)) {
    prefs.app = s.app; localStorage.setItem(CACHE_KEY, JSON.stringify(s.app));
    for (const fn of listeners) fn();
  }
}

export async function loadPrefs() {
  setPrefs(await api<{ tune?: { fixRounds?: number }; app?: AppPrefs }>("/api/settings").catch(() => null));
}
