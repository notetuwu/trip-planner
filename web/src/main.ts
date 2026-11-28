// Entry point: wires up every part of the page and loads the current trip.
import "./styles";
import { goToStop } from "./map/days";
import { initLayout, showPane } from "./core/layout";
import { startEmptyPlan } from "./itinerary/manual";
import { initBookings, renderBookings } from "./trip/bookings";
import { $, api, closeDialogsOnBackdrop } from "./core/dom";
import { initUpdates } from "./core/update";
import { initWindowMode } from "./core/window-mode";
import { hydrateIcons } from "./core/icons";
import { initTheme } from "./core/theme";
import { session, state } from "./core/state";
import { geocodeStays, onGeocoded } from "./geo/geocode";
import { byTitleMap, geocodeItems, itemLoc } from "./geo/item-loc";
import { countryCodes, geocodePlaces, stayLoc, warmNearby } from "./geo/locate";
import { initModels, refreshModels } from "./generate/models";
import { runGeneration } from "./generate/run";
import { offlineHtml } from "./export/offline";
import { directionsUrl, initDirectionLinks } from "./itinerary/directions";
import { renderItinerary } from "./itinerary/render";
import { refreshLinks } from "./itinerary/book-ahead";
import { initSearchKey } from "./itinerary/search";
import { loadWeather } from "./itinerary/weather";
import { initDays, selectDay } from "./map/days";
import { drawMap } from "./map/draw";
import { initRideStops, setOnPlanChanged, updateLegInfo } from "./map/legs";
import { initMap, map as leafletMap } from "./map/map";
import { dayLegs, routeKey, routes, setOnRouted } from "./map/routes";
import { initMapSearch } from "./map/search";
import { initChips, renderChips } from "./places/chips";
import { initLists, loadList, refreshLists } from "./places/lists";
import { applyState, importTrip, initSaves, refreshSaves, startFresh } from "./saves/saves";
import { initFields, onNames } from "./trip/fields";
import { initStays, renderStays } from "./trip/stays";
import { initRoutePlanner } from "./trip/route-planner";
import { initCompanion } from "./trip/companion";
import { initPrint } from "./export/print";
import { initSettings } from "./settings/settings";
import { initQuickstart } from "./setup/quickstart";
import { initGames } from "./games/games";
import { greet } from "./setup/greet";
import { initSync } from "./core/sync";
import { loadPrefs, onAppPrefs, prefs } from "./core/prefs";
import { renderTripTitle } from "./trip/title";

// New coordinates arrived: redraw, and once the stays' countries are known, look up hotels, place names and
// itinerary stops inside those countries.
let lastCountries = "";
onGeocoded(() => {
  renderStays(); renderTripTitle(); drawMap(); renderChips(); refreshLinks(); // links: websites found by the lookups
  geocodeStays();
  const cc = countryCodes();
  // Booking links depend on the countries (Klook vs GetYourGuide), so the itinerary is redrawn once they're known.
  if (cc && cc !== lastCountries) { lastCountries = cc; geocodePlaces(); loadWeather(); renderItinerary(); }
  geocodeItems(); // asks only for stops not looked up yet, e.g. once their day's town is known
  warmNearby();
});
// A suggested journey (a travel day without its rides) fills in once the way between the stays is found.
setOnRouted(() => { drawMap(); updateLegInfo(); if (document.querySelector(".journey.suggested")) renderItinerary(); });
// Stops whose words were changed to the timetable's line: drawn again (their leg may now go another way).
setOnPlanChanged(() => { renderItinerary(); drawMap(); });
initRideStops(goToStop);
onNames(() => { renderItinerary(); drawMap({ fit: false }); });

hydrateIcons(); initTheme();
initSearchKey(); initUpdates(); initWindowMode();
// Every dialog, in the page or added later, closes on a click outside it.
closeDialogsOnBackdrop();
initSettings(); initQuickstart(); initSync(); initGames();
// Settings → General changed (or came in from the computer): redraw in the new units and formats.
onAppPrefs(() => { renderBookings(); renderStays(); renderTripTitle(); renderItinerary(); drawMap(); });
initFields(); initBookings(); initStays(); initRoutePlanner(); initCompanion(); initPrint(); initLists(); initChips(); initModels(); initSaves(); initDays(); initMapSearch(); initDirectionLinks();
$("#generate").onclick = () => runGeneration();
$("#emptyPlan").onclick = () => { showPane("output"); startEmptyPlan(); };

// For debugging in the browser console and for end-to-end tests.
Object.assign(window, {
  planner: { state: () => state, session, applyState, importTrip, selectDay, drawMap, renderItinerary, itemLoc, byTitleMap, dayLegs, routes, routeKey, stayLoc, directionsUrl, offlineHtml, map: () => leafletMap },
});

// Tells the server this window is open, and when it closes (the packaged app quits after its last window closes).
const pageId = Math.random().toString(36).slice(2);
const heartbeat = () => api(`/api/ping?id=${pageId}`).catch(() => {});
heartbeat(); setInterval(heartbeat, 20000);
addEventListener("pagehide", () => navigator.sendBeacon(`/api/bye?id=${pageId}`));
addEventListener("pageshow", (e) => { if (e.persisted) heartbeat(); }); // back from the browser's page cache

initMap();
initLayout();
refreshModels();
renderStays(); renderTripTitle(); renderItinerary();
refreshSaves();
geocodeStays();
await refreshLists();
await loadList();
loadWeather();
await loadPrefs();
// Settings → General: start with a new trip (the one that was open goes to Saved trips first).
if (prefs.app.startWith === "new") await startFresh();
// The first time the app starts: the quick-start guide. The first start after an update: what's new.
greet();
