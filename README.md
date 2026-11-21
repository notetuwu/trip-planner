# Local Trip Planner

A day-by-day itinerary planner that runs on your own machine. Tell it where you're staying, add the places you want to see, and it plans every day with real places, opening hours, costs, public holidays and routes on a live map. Then take the plan with you as one offline HTML file on your phone.

It uses **Claude** through your own [Claude Code](https://claude.com/claude-code) login, a **local model** (Ollama, LM Studio, llama.cpp and other OpenAI-compatible servers), or, if you add an API key, **Claude, GPT and other cloud models** billed per use. It has no accounts and no cloud backend, and none of these needs more setup than being installed or having a key.

![Trip planner with a Lisbon itinerary, holidays and a routed map](docs/screenshot.png)

## Features

- **Any destination.** The country is worked out from your stays. Stay dates chain together automatically, and each stay is located on the map.
- **Your places first.** Import a Google Maps list (by share link or Takeout CSV), add places by name or by clicking the map, and mark them as must-see or skip. In groups, a must-see can be marked for only some travellers, and the planner can split the group for it.
- **Real places, not invented ones.** Before planning, sights and restaurants around each stay are pulled from OpenStreetMap and given to the model. Stops are pinned at their exact location, and doubtful ones are flagged.
- **Online research.** The model can look up opening hours, prices, events and connections while it plans. Claude and API models use their provider's own web search, and local models get a search and page-fetch loop run by the server.
- **Opening hours checked.** Stops that are real OpenStreetMap places with listed hours are checked against the day and time they're planned for, including public holidays, with a warning such as "Closed on Monday" or "Closes at 17:00".
- **Booking in one place.** Stops with tickets or tours get a link to one big booking platform for the whole trip (Klook for trips in East and Southeast Asia, GetYourGuide elsewhere) instead of a different site per attraction. A "Book ahead" checklist collects everything that sells out or needs a slot, with how far ahead to book; tick items off as you book them.
- **Public holidays and events.** Official holidays for your dates (from date.nager.at), plus the festivals and closures the model finds.
- **Transport you choose.** Set car, train, bus, flight, ferry or bike for each leg between stays, and for day trips. Day trips go on full days, never on travel days.
- **Routed map.** Walking legs follow footpaths and driving legs follow roads. Hover a line to see the day, the stops it connects, the distance and the time. Each stop has a "Route ↗" link to Google Maps directions in the right travel mode.
- **Live reasoning.** You can follow the model's planning notes, web lookups and token speed as it works, and see the full prompt it was sent.
- **Revise.** Ask for changes ("swap days 3 and 4", "add a vegan lunch on day 2"), re-plan a single day with ↻ (optionally saying what to change) while the rest stays as it is, or remove and add stops yourself.
- **Budget and weather.** Costs per stop and per day against your daily budget, plus a forecast when the trip is close enough.
- **Take it with you.** "Download for phone" saves one self-contained HTML file with the map, the days and a jump-to-today button. A calendar file (.ics) puts every stop in your phone's calendar. Print/PDF and JSON export are also available.

## Requirements

- [Node.js](https://nodejs.org) 22.12 or newer.
- One of:
  - **Claude Code**, installed and logged in (`claude` works in your terminal). Generation uses your Claude subscription.
  - **A local model server:** [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), llama.cpp server, Jan, KoboldCpp, GPT4All or vLLM. Running servers are detected automatically.
  - **An API key** from [Anthropic](https://console.anthropic.com/settings/keys), [OpenAI](https://platform.openai.com/api-keys) or [OpenRouter](https://openrouter.ai/keys) (one key for many labs' models). You pay the provider per use.
- Python 3, optional, for the `start.py` launcher.

## Run it

```sh
python start.py            # installs, builds if needed, starts the server and opens http://localhost:5173
python start.py --port 8080 --no-browser
```

Or with npm:

```sh
npm install
npm run build
npm start
```

Your trips are saved in `saves/`, imported place lists in `lists/`, and map lookups are cached in `cache/`. All three stay on your machine and are ignored by git.

## Choosing a model

Pick one from the **Model** menu. Claude via Claude Code comes first, then models from any provider you have an API key for, then detected local models (click ⟳ to detect them again).

**API keys:** click 🔑 next to the Model menu, or set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` (also from a `.env` file in the project folder). Keys entered on the page are saved in `keys.json` in the project folder, which is gitignored. They're only sent to that provider and never end up in saves or exports. The page itself never gets them back, only whether a key is set. With research on, API models search the web with their provider's own search tool, which is billed per search on top of tokens. After a plan, the cost is shown below it: estimated for Anthropic, reported by OpenRouter, and not shown for OpenAI. The Claude Code option keeps using your subscription, even if `ANTHROPIC_API_KEY` is set.

For local models, bigger is better. The planner asks for long, structured JSON with many days. Models that handle this well include recent Qwen models (e.g. `qwen3:14b`, or `qwen3:30b` on a 24 GB GPU) and `gpt-oss:20b`. Small models tend to leave out stops and cost breakdowns.

Ollama tips for speed and long prompts:

```sh
setx OLLAMA_FLASH_ATTENTION 1
setx OLLAMA_KV_CACHE_TYPE q8_0
```

(Those are the Windows commands; on macOS or Linux set them as environment variables for the Ollama service. Restart Ollama afterwards.)

## Configuration

Everything is optional and set through environment variables:

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on (default `5173`) |
| `CLAUDE_BIN` | Path to the `claude` CLI, if it isn't found automatically |
| `OLLAMA_URL` | Ollama address (default `http://127.0.0.1:11434`) |
| `LOCAL_LLM_URLS` | Extra OpenAI-compatible servers to probe, comma-separated (e.g. `http://192.168.1.20:1234`) |
| `OLLAMA_NUM_CTX` | Fixed context size for Ollama, instead of sizing it to the prompt |
| `BRAVE_API_KEY` | Use the [Brave Search API](https://brave.com/search/api/) for local models' web research (most reliable) |
| `SEARXNG_URL` | Use your own SearXNG instance for research (needs the JSON format enabled) |
| `RESEARCH_MAX_LOOKUPS` | Most searches and page fetches a local model may make (default 30) |
| `PLACES_CSV` | A CSV of places to import on startup |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` | API keys for cloud models (or add them on the page) |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL` | Send API requests through a proxy or compatible endpoint |

Without `BRAVE_API_KEY` or `SEARXNG_URL`, local research falls back to DuckDuckGo, then to Wikivoyage and Wikipedia.

## Services it uses

The app is local, but it calls these free public services. Please keep use personal and moderate: requests are rate-limited and cached on purpose, and heavy or commercial use needs your own instances or paid providers.

- **[Nominatim](https://nominatim.org) and [Photon](https://photon.komoot.io):** finding places on the map
- **[Overpass API](https://overpass-api.de):** real sights and restaurants around each stay
- **[OSRM](https://project-osrm.org) and [FOSSGIS routing](https://routing.openstreetmap.de):** walking and driving routes
- **[OpenStreetMap tiles](https://www.openstreetmap.org)** (in the app) and **Esri World Street Map** (in the phone export)
- **[Nager.Date](https://date.nager.at):** public holidays
- **[Open-Meteo](https://open-meteo.com):** weather forecasts

Map data © OpenStreetMap contributors.

The **Google Maps list import** uses an unofficial Google endpoint, the same one the list's share page loads. It can break whenever Google changes it. A [Google Takeout](https://takeout.google.com) CSV of your saved lists always works.

## How it works

The browser app is written in TypeScript and built with [Vite](https://vite.dev). It uses [Leaflet](https://leafletjs.com) for the map and has no UI framework. The server is a plain Node HTTP server, also in TypeScript. Its only dependencies are the Anthropic SDK and the `opening_hours` parser.

When you generate, the server gathers holidays and nearby places, builds one detailed prompt, and then runs `claude -p` with a JSON schema, calls the Anthropic Messages API or the OpenAI/OpenRouter Responses API, or talks to the local model server directly. Progress streams back to the page as newline-delimited JSON.

```
index.html          page markup (Vite entry)
web/src/
  main.ts           wires everything up
  core/             state, DOM helpers, formatting
  geo/              geocoding and where stays, places and stops are
  trip/             stays editor, transport modes, settings fields, title
  places/           place lists and chips
  map/              Leaflet map, drawing, routes, adding stops, search
  itinerary/        itinerary rendering, directions, booking links, opening hours, weather
  generate/         model picker, API keys dialog, request, live progress, stream reader
  export/           the offline phone export and the calendar (.ics)
  saves/            saved trips
  styles/           CSS
server/
  main.ts           production server (serves dist/web and the API)
  api.ts            routes for /api/*
  ai/               prompt, schema, runners for Claude Code, the Anthropic API, OpenAI/OpenRouter and local models
  research/         web search and page reading for local models
  geo/              geocoding, reverse lookup, routing
  trip/             holidays, real places and opening hours from OpenStreetMap
  keys.ts           API keys (environment, .env or keys.json)
  lists/            place lists: CSV, Google Maps import, storage
shared/             types used by both sides
tests/              unit tests
```

## Development

```sh
npm run dev         # Vite dev server with hot reload; the API runs inside it (server changes reload too)
npm run typecheck   # TypeScript checks for the app, the server and the tests
npm test            # unit tests (Vitest)
npm run build       # production build into dist/
```

GitHub Actions runs the typecheck, the tests and the build on every push.

`python start.py --dev` does the same as `npm run dev` and opens the browser.

## License

[MIT](LICENSE)
