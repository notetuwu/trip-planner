// Entry point: wires up every part of the page and loads the current trip.
import "./styles";
import { $ } from "./core/dom";
import { session, state } from "./core/state";
import { geocodeStays, onGeocoded } from "./geo/geocode";
import { byTitleMap, geocodeItems, itemLoc } from "./geo/item-loc";
import { countryCodes, geocodePlaces, warmNearby } from "./geo/locate";
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
import { updateLegInfo } from "./map/legs";
import { initMap } from "./map/map";
import { dayLegs, routeKey, routes, setOnRouted } from "./map/routes";
import { initMapSearch } from "./map/search";
import { initChips, renderChips } from "./places/chips";
import { initLists, loadList, refreshLists } from "./places/lists";
import { applyState, initSaves, refreshSaves } from "./saves/saves";
import { initFields } from "./trip/fields";
import { initStays, renderStays } from "./trip/stays";
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
setOnRouted(() => { drawMap(); updateLegInfo(); });

initSearchKey();
initFields(); initStays(); initLists(); initChips(); initModels(); initSaves(); initDays(); initMapSearch(); initDirectionLinks();
$("#generate").onclick = () => runGeneration();

// For debugging in the browser console and for end-to-end tests.
Object.assign(window, {
  planner: { state: () => state, session, applyState, selectDay, drawMap, renderItinerary, itemLoc, byTitleMap, dayLegs, routes, routeKey, directionsUrl, offlineHtml },
});

initMap();
refreshModels();
renderStays(); renderTripTitle(); renderItinerary();
refreshSaves();
geocodeStays();
await refreshLists();
await loadList();
loadWeather();
