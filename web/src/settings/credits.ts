// Settings → Credits: the services, data and open-source projects the planner is built on, what each one is used for,
// and its licence where it asks to be named.
import { esc } from "../core/dom";
import { ext, icon } from "../core/icons";

interface Credit { name: string; url: string; what: string; licence?: string }
type IconName = Parameters<typeof icon>[0];

const GROUPS: { title: string; ico: IconName; intro: string; items: Credit[] }[] = [
  {
    title: "Maps and places", ico: "map", intro: "The map, finding places by name, and the real sights and restaurants around each stay.",
    items: [
      { name: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright", what: "The map, and the data behind places, opening hours and routes", licence: "© OpenStreetMap contributors, ODbL" },
      { name: "Nominatim", url: "https://nominatim.org", what: "Finding towns, hotels and stops by name (the OpenStreetMap Foundation's server)" },
      { name: "Geoapify", url: "https://www.geoapify.com", what: "A faster place search, with your own free key" },
      { name: "Photon by Komoot", url: "https://photon.komoot.io", what: "Place search when Nominatim doesn't find a name" },
      { name: "Overpass API", url: "https://overpass-api.de", what: "Sights and restaurants near your stays (also the private.coffee and VK Maps servers)" },
      { name: "OpenFreeMap and OpenMapTiles", url: "https://openfreemap.org", what: "The map with English place names", licence: "© OpenMapTiles, data © OpenStreetMap contributors" },
      { name: "Esri", url: "https://www.esri.com", what: "The map in the phone file", licence: "Tiles © Esri" },
      { name: "Leaflet", url: "https://leafletjs.com", what: "Showing the maps", licence: "BSD 2-Clause" },
      { name: "MapLibre GL", url: "https://maplibre.org", what: "Drawing the English-names map", licence: "BSD 3-Clause" },
    ],
  },
  {
    title: "Routes and travel", ico: "route", intro: "Real road and walking times, and train connections.",
    items: [
      { name: "OSRM", url: "https://project-osrm.org", what: "Driving routes and times (the project's demo server)", licence: "BSD 2-Clause" },
      { name: "FOSSGIS routing", url: "https://routing.openstreetmap.de", what: "Driving and walking routes (run by FOSSGIS e.V.)" },
      { name: "Transitous", url: "https://transitous.org", what: "Real train and bus connections between stays" },
    ],
  },
  {
    title: "Weather, daylight and dates", ico: "cloudSun", intro: "What the days will be like, and what's on.",
    items: [
      { name: "Open-Meteo", url: "https://open-meteo.com", what: "Weather forecasts and time zones (for sunrise and sunset)", licence: "CC BY 4.0" },
      { name: "Nager.Date", url: "https://date.nager.at", what: "Public holidays in the countries you visit" },
      { name: "opening_hours.js", url: "https://github.com/opening-hours/opening_hours.js", what: "Reading OpenStreetMap's opening hours, to check stops are open", licence: "LGPL 3.0" },
      { name: "NOAA solar calculator", url: "https://gml.noaa.gov/grad/solcalc/", what: "The formula for sunrise and sunset" },
    ],
  },
  {
    title: "Pictures", ico: "images", intro: "The trip preview's pictures of places, when switched on.",
    items: [
      { name: "Wikimedia Commons", url: "https://commons.wikimedia.org", what: "Pictures of places, found through their Wikipedia articles; each shows its author and licence", licence: "Free licences, per picture" },
    ],
  },
  {
    title: "Money", ico: "wallet", intro: "Costs in your currency, and what the drives cost in fuel.",
    items: [
      { name: "Frankfurter", url: "https://frankfurter.dev", what: "Exchange rates (the European Central Bank's reference rates)" },
      { name: "fuel-prices.eu", url: "https://www.fuel-prices.eu", what: "Weekly fuel prices per country, and Switzerland's monthly average (Swiss Federal Statistical Office), for the fuel estimate", licence: "CC BY 4.0" },
      { name: "Natural Resources Canada", url: "https://natural-resources.canada.ca/energy-sources-distribution/fuel-prices", what: "Weekly Canadian fuel prices, for the fuel estimate", licence: "Open Government Licence – Canada" },
      { name: "Australian Institute of Petroleum", url: "https://aip.com.au/pricing/pump-prices/", what: "Weekly Australian petrol prices, for the fuel estimate" },
      { name: "US Energy Information Administration", url: "https://www.eia.gov/petroleum/gasdiesel/", what: "Weekly US fuel prices, for the fuel estimate", licence: "Public domain" },
    ],
  },
  {
    title: "Web research", ico: "search", intro: "How local models look things up (Claude and API models use their provider's own search).",
    items: [
      { name: "DuckDuckGo", url: "https://duckduckgo.com", what: "Web search when nothing else is set up" },
      { name: "Wikipedia and Wikivoyage", url: "https://www.wikimedia.org", what: "Background on places, and searches when others fail", licence: "CC BY-SA 4.0" },
      { name: "Wikidata", url: "https://www.wikidata.org", what: "Official websites of places", licence: "CC0" },
      { name: "Brave Search API", url: "https://brave.com/search/api/", what: "Web search with your own key" },
      { name: "SearXNG", url: "https://docs.searxng.org", what: "The search engine you can run on this computer", licence: "AGPL 3.0" },
      { name: "Docker", url: "https://www.docker.com", what: "Runs SearXNG on this computer" },
    ],
  },
  {
    title: "AI models", ico: "sparkles", intro: "The models that write the plans and answer in the chat.",
    items: [
      { name: "Claude Code and Anthropic", url: "https://www.anthropic.com", what: "Claude, through Claude Code or an Anthropic API key (and the Anthropic SDK)", licence: "SDK: MIT" },
      { name: "OpenAI", url: "https://openai.com", what: "GPT models with your own key" },
      { name: "OpenRouter", url: "https://openrouter.ai", what: "Many labs' models with one key" },
      { name: "Ollama", url: "https://ollama.com", what: "Local models on your own graphics card, and its model library", licence: "MIT" },
    ],
  },
  {
    title: "The app", ico: "monitor", intro: "What it's made with.",
    items: [
      { name: "Microsoft Edge WebView2", url: "https://developer.microsoft.com/microsoft-edge/webview2/", what: "The app's window on Windows", licence: "SDK: BSD 3-Clause" },
      { name: "Lucide", url: "https://lucide.dev", what: "The icons", licence: "ISC" },
      { name: "Inter", url: "https://rsms.me/inter/", what: "The typeface (through Google Fonts)", licence: "SIL Open Font License" },
      { name: "qrcode-generator", url: "https://github.com/kazuhikoarase/qrcode-generator", what: "The QR code for your phone", licence: "MIT" },
      { name: "Node.js, TypeScript, Vite, esbuild and Vitest", url: "https://nodejs.org", what: "Running and building the app, and its tests", licence: "MIT, Apache 2.0" },
      { name: "Tailscale", url: "https://tailscale.com", what: "Using the planner on your phone away from home" },
      { name: "GitHub", url: "https://github.com/notetuwu/trip-planner", what: "Where the app is published, and where updates come from" },
    ],
  },
  {
    title: "Links out", ico: "external", intro: "Places the plan links to; nothing is sent to them unless you click.",
    items: [
      { name: "Google Maps, Apple Maps and Bing Maps", url: "https://www.google.com/maps", what: "Places and directions, in the maps app you chose" },
      { name: "Booking.com, GetYourGuide, Klook and Rome2rio", url: "https://www.rome2rio.com", what: "Booking hotels, tickets and transport from Book ahead" },
      { name: "Official toll and vignette shops", url: "https://www.asfinag.at", what: "Road vignettes for the countries you drive through" },
    ],
  },
];

export function creditsHtml() {
  return `<h3>Credits</h3>
    <p class="hint credits-intro">Trip Planner stands on the work of many people: open data, free services and open-source projects. Thank you to all of them.</p>
    ${GROUPS.map((g) => `<div class="set-card credits-card">
      <b class="card-title credits-title">${icon(g.ico)} ${esc(g.title)}</b><p class="hint">${esc(g.intro)}</p>
      <ul class="credits-list">${g.items.map((c) => `<li>
        <a href="${esc(c.url)}" target="_blank" rel="noopener"><b>${esc(c.name)}</b>${ext()}</a>
        <span class="credits-what">${esc(c.what)}</span>${c.licence ? `<span class="credits-lic">${esc(c.licence)}</span>` : ""}</li>`).join("")}</ul>
    </div>`).join("")}`;
}
