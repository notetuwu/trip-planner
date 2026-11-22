// The app's styles. Imported once by main.ts; the phone export (export/offline.ts) inlines the same CSS as text.
import base from "./base.css?raw";
import days from "./days.css?raw";
import itinerary from "./itinerary.css?raw";
import map from "./map.css?raw";
import print from "./print.css?raw";
import settings from "./settings.css?raw";
// Leaflet's own styles first, so the app's (dark mode popups and tooltips) override them.
import "leaflet/dist/leaflet.css";
import "./base.css";
import "./settings.css";
import "./map.css";
import "./itinerary.css";
import "./days.css";
import "./print.css";

export const APP_CSS = [base, settings, map, itinerary, days, print].join("\n");
