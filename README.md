# Local Trip Planner

A day-by-day itinerary planner that runs on your own machine. Tell it where you're staying, add the places you want to see, and it plans every day with real places, opening hours, costs, public holidays and routes on a live map. Then take the plan with you as one offline HTML file on your phone.

It uses either **Claude** (through your own [Claude Code](https://claude.com/claude-code) login) or a **local model** (Ollama, LM Studio, llama.cpp and other OpenAI-compatible servers). It has no accounts, no cloud backend and no API keys to set up.

![Trip planner with a Lisbon itinerary, holidays and a routed map](docs/screenshot.png)

## Features

- **Any destination.** The country is worked out from your stays. Stay dates chain together automatically, and each stay is located on the map.
- **Your places first.** Import a Google Maps list (by share link or Takeout CSV), add places by name or by clicking the map, and mark them as must-see or skip. In groups, a must-see can be marked for only some travellers, and the planner can split the group for it.
- **Real places, not invented ones.** Before planning, sights and restaurants around each stay are pulled from OpenStreetMap and given to the model. Stops are pinned at their exact location, and doubtful ones are flagged.
- **Online research.** The model can look up opening hours, prices, events and connections while it plans. Claude uses its built-in web search, and local models get a search and page-fetch loop run by the server.
- **Public holidays and events.** Official holidays for your dates (from date.nager.at), plus the festivals and closures the model finds.
- **Transport you choose.** Set car, train, bus, flight, ferry or bike for each leg between stays, and for day trips. Day trips go on full days, never on travel days.
- **Routed map.** Walking legs follow footpaths and driving legs follow roads. Hover a line to see the day, the stops it connects, the distance and the time. Each stop has a "Route ↗" link to Google Maps directions in the right travel mode.
- **Live reasoning.** You can follow the model's planning notes, web lookups and token speed as it works, and see the full prompt it was sent.
- **Revise.** Ask for changes ("swap days 3 and 4", "add a vegan lunch on day 2"), or remove and add stops yourself.
- **Budget and weather.** Costs per stop and per day against your daily budget, plus a forecast when the trip is close enough.
- **Take it with you.** "Download for phone" saves one self-contained HTML file with the map, the days and a jump-to-today button. Print/PDF and JSON export are also available.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer. There is nothing to `npm install`.
- One of:
  - **Claude Code**, installed and logged in (`claude` works in your terminal). Generation uses your Claude subscription.
  - **A local model server:** [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), llama.cpp server, Jan, KoboldCpp, GPT4All or vLLM. Running servers are detected automatically.
- Python 3, optional, for the `start.py` launcher.

## Run it

```sh
python start.py            # starts the server and opens http://localhost:5173
python start.py --port 8080 --no-browser
```

Or start it without Python:

```sh
node server.js
```

Your trips are saved in `saves/`, imported place lists in `lists/`, and map lookups are cached in `cache/`. All three stay on your machine and are ignored by git.

## Choosing a model

Pick one from the **Model** menu. Claude models come first, and any detected local models are listed below them (click ⟳ to detect them again).

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

`server.js` is a single dependency-free Node server. It serves `public/index.html` (the whole UI in one file, with [Leaflet](https://leafletjs.com) for the map) and a few JSON endpoints.

When you generate, it gathers holidays and nearby places, builds one detailed prompt, and then either runs `claude -p` with a JSON schema or talks to the local model server directly. The progress streams back to the page as NDJSON.

## License

[MIT](LICENSE)
