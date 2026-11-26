// Browser tests of the main flows, against the built app in a headless browser (npm run build && npm run e2e).
// The server calls that need the internet or an AI model are answered inside the page (see STUBS), so the tests are
// fast and repeatable: place lookups know a few towns, routes come back as straight lines, and "the model" returns
// whatever the test sets in window.__e2e.answer.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { launch } from "./browser.mjs";

const STUBS = `(() => {
  const TOWNS = {
    padua: [45.4064, 11.8768, "it", "Italy"], venice: [45.4408, 12.3155, "it", "Italy"], milano: [45.4642, 9.19, "it", "Italy"],
    lucerne: [47.0502, 8.3093, "ch", "Switzerland"], bregenz: [47.5031, 9.7471, "at", "Austria"],
    osaka: [34.6937, 135.5023, "jp", "Japan"], kyoto: [35.0116, 135.7681, "jp", "Japan"], hakone: [35.2324, 139.1069, "jp", "Japan"],
    tunis: [36.8065, 10.1815, "tn", "Tunisia"], "cape town": [-33.9249, 18.4241, "za", "South Africa"],
    cairo: [30.0444, 31.2357, "eg", "Egypt"], nairobi: [-1.2921, 36.8219, "ke", "Kenya"],
  };
  const geoKey = (q, cc, near, stop) => String(q).trim().toLowerCase() + "|" + (cc || "")
    + (near ? "|" + (+near[0]).toFixed(1) + "," + (+near[1]).toFixed(1) : "") + (stop ? "|s2" : "");
  const hit = (q) => {
    const name = String(q).split(",")[0].trim().toLowerCase(), t = TOWNS[name];
    return t ? { lat: t[0], lng: t[1], name: name[0].toUpperCase() + name.slice(1), label: name + ", " + t[3], country: t[3], cc: t[2], kind: "city" } : null;
  };
  const p5 = (n) => (+n).toFixed(5);
  const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } }));
  window.__e2e = { open: [], requests: [], answer: () => null, delay: 0, stops: { km: 12733, hours: 156, stops: [], picked: "model" } };
  const real = window.fetch.bind(window);
  window.fetch = (u, o = {}) => {
    const url = String(u), body = () => JSON.parse(o.body || "{}");
    if (url.includes("/api/geocode")) {
      const results = {};
      for (const q of body().queries || []) results[geoKey(q.q, q.cc, q.near, q.stop)] = hit(q.q);
      return json({ results, pending: 0, queued: 0 });
    }
    if (url.includes("/api/routes")) {
      const routes = {};
      for (const l of body().legs || []) {
        routes[l.mode + ":" + p5(l.from[0]) + "," + p5(l.from[1]) + ">" + p5(l.to[0]) + "," + p5(l.to[1])] = null;
        (window.__e2e.routeModes ||= []).push(l.mode);
      }
      return json({ routes, pending: 0 });
    }
    if (url.includes("/api/hours")) return json((body().checks || []).map(() => ({ status: "unknown", text: "" })));
    if (url.includes("/api/open")) { window.__e2e.open.push(body().url); return json({ ok: true }); }
    if (url.includes("/api/nearby")) return json({ warming: 0 });
    // Updates: scripted by the test through window.__e2e.update (absent: no update).
    const up = window.__e2e.update;
    if (up && url.includes("/api/update/status")) return json(up.statuses.length > 1 ? up.statuses.shift() : up.statuses[0]);
    if (up && url.endsWith("/api/update") && (o.method || "GET") === "POST") return json({ phase: "downloading", received: 0, total: 1 });
    if (up && url.endsWith("/api/update")) return json(up.info);
    if (up && url.includes("/api/health")) return json({ app: "trip-planner", version: up.statuses.length > 1 ? up.info.current : up.info.latest });
    // Streamed helpers: a status line, a token count, then the result (like the real server).
    const stream = (result) => Promise.resolve(new Response([{ type: "status", text: "Working…" }, { type: "tokens", n: 42 }, { type: "reasoning", text: "Lakes first, then the loop home." }, { type: "done", result }]
      .map((e) => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10), { status: 200 }));
    if (url.includes("/api/current")) return json({ at: 0 });
    // The quick-start guide opens by itself on a first start, the update log after an update: not over the tests (one
    // test opens the guide itself).
    if (url.endsWith("/api/settings") && (o.method || "GET") === "GET" && !window.__e2e.firstStart) return real(u, o).then((r) => r.json()).then((s) => json({ ...s, quickstartSeen: true, seenVersion: "99999.0.0" }));
    if (url.endsWith("/api/setup") && window.__e2e.setup) return json(window.__e2e.setup);
    if (url.endsWith("/api/trips") && window.__e2e.trips) return json(window.__e2e.trips);
    if (url.endsWith("/api/models") && window.__e2e.models) return json(window.__e2e.models);
    // Place lists: scripted by the test through window.__e2e.lists ({ name: places }); absent: the real (empty) ones.
    const lists = window.__e2e.lists;
    const listPath = url.split("?")[0].split("/api/lists")[1];
    if (lists && listPath === "") return json(Object.entries(lists).map(([name, places]) => ({ name, count: places.length, source: { type: "csv" } })));
    if (lists && listPath && listPath.lastIndexOf("/") === 0) { const name = decodeURIComponent(listPath.slice(1)); return json({ name, places: lists[name] || [], source: { type: "csv" } }); }
    if (url.includes("/api/stops")) { window.__e2e.stopsAsked = body(); return stream(window.__e2e.stops); }
    if (url.includes("/api/route-plan")) { window.__e2e.routeAsked = body(); return stream(window.__e2e.route); }
    if (url.includes("/api/companion/compact")) { window.__e2e.compactAsked = body(); return stream({ summary: "- They want Pedrocchi on the way." }); }
    if (url.includes("/api/companion")) { window.__e2e.companionAsked = body(); return stream(window.__e2e.companion || { answer: "On **day 2** you're in Padua:" + String.fromCharCode(10) + "- 10:00 Basilica" }); }
    if (url.includes("/api/itinerary")) {
      const b = body();
      window.__e2e.requests.push(b);
      const done = { type: "done", itinerary: window.__e2e.answer(b), reasoning: "test", engine: "test" };
      return new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(done) + String.fromCharCode(10), { status: 200 })), window.__e2e.delay));
    }
    return real(u, o);
  };
})();`;

// Shared in-page helpers for building plans.
const HELPERS = `
  window.day = (date, city, items) => ({ date, city, title: city, estimatedCost: 0, items });
  window.stop = (time, place, extra = {}) => ({ time, place, description: "", ...extra });
`;

let page, stop;
before(async () => {
  ({ page, stop } = await launch());
  await page.addInitScript(STUBS + HELPERS);
});
after(() => stop?.());
beforeEach(async () => {
  await page.goto();
  await page.eval(`localStorage.clear(); sessionStorage.clear(); location.reload()`).catch(() => {});
  await page.waitFor("document.readyState === 'complete' && !!window.planner");
});

/** Loads a trip into the page and waits for the stays to be located. */
/** The app's own question dialog (core/ask.ts) that just opened: confirmed as it is (an empty or prefilled answer), or
 *  with `text` typed in. */
async function answerAsk(text) {
  await page.waitFor(`!!document.querySelector(".ask-dialog[open]")`, 5000, "the app's dialog");
  if (text != null) await page.eval(`(() => { const f = document.querySelector(".ask-dialog[open] .ask-input"); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event("input")); })()`);
  await page.eval(`document.querySelector(".ask-dialog[open] [type=submit]").click()`);
}

async function trip(state) {
  await page.eval(`planner.applyState(${JSON.stringify(state)})`);
  await page.waitFor(`document.querySelectorAll(".stay-geo").length >= ${state.stays.length} && ![...document.querySelectorAll(".stay-geo")].some((e) => /Locating/.test(e.textContent))`, 10000, "stays located");
}

const PADUA_MILANO = {
  stays: [{ city: "Padua", start: "2027-09-14", nights: 2, hotel: "" }, { city: "Milano", start: "2027-09-16", nights: 2, hotel: "", travel: "car" }],
  list: "", listChosen: true, autoFix: false,
  customPlaces: [{ title: "Caffe Pedrocchi", lat: 45.4078, lng: 11.8775, custom: true }],
};

test("a stop in the wrong town is offered for fixing, and only that day comes back", async () => {
  await trip(PADUA_MILANO);
  await page.eval(`window.__e2e.answer = (b) => b.fix
    ? { summary: "Swapped.", totalEstimatedCost: 0, days: [day("2027-09-17", "Milano", [stop("10:00", "Castello Sforzesco"), stop("13:00", "Luini")])] }
    : { summary: "Plan", totalEstimatedCost: 0, days: [
        day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")]),
        day("2027-09-15", "Padua", [stop("10:00", "Basilica")]),
        day("2027-09-16", "Padua → Milano", [stop("17:00", "Duomo di Milano")]),
        day("2027-09-17", "Milano", [stop("10:00", "Castello Sforzesco"), stop("13:00", "Caffe Pedrocchi")]),
      ] }`);
  await page.eval(`document.querySelector("#generate").click()`);
  await page.waitFor(`!document.querySelector("#fixBar")?.hidden && /wrong town/.test(document.querySelector("#fixBar").textContent)`, 20000, "the fix bar");
  await page.eval(`document.querySelector("#fixBar [data-fix]").click()`);
  await page.waitFor(`window.__e2e.requests.length === 2`);
  const fix = await page.eval(`window.__e2e.requests[1].fix.problems`);
  assert.equal(fix.length, 1);
  assert.match(fix[0].text, /Caffe Pedrocchi/);
  assert.equal(fix[0].day, 3);
  await page.waitFor(`planner.state().itinerary.days[3].items[1]?.place === "Luini"`);
  assert.equal(await page.eval(`planner.state().itinerary.days[0].items[0].place`), "Cappella degli Scrovegni", "other days untouched");
  await page.waitFor(`document.querySelector("#fixBar")?.hidden === true`, 15000, "the fix bar to go");
});

test("with automatic fixing on, the plan comes back already fixed", async () => {
  await trip({ ...PADUA_MILANO, autoFix: true });
  await page.eval(`window.__e2e.answer = (b) => b.fix
    ? { summary: "Swapped.", totalEstimatedCost: 0, days: [day("2027-09-17", "Milano", [stop("13:00", "Luini")])] }
    : { summary: "Plan", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")]),
        day("2027-09-17", "Milano", [stop("13:00", "Caffe Pedrocchi")])] }`);
  await page.eval(`window.__seen = []; new MutationObserver(() => { if (document.querySelector("#output .day")) window.__seen.push([...document.querySelectorAll("#output .item .name")].map((e) => e.textContent.trim()).join()); }).observe(document.querySelector("#output"), { childList: true, subtree: true }); document.querySelector("#generate").click()`);
  await page.waitFor(`window.__e2e.requests.length === 2 && planner.state().itinerary?.days[1].items[0].place === "Luini" && !!document.querySelector("#output .day")`, 30000, "the fixed plan");
  assert.ok(await page.eval(`window.__e2e.requests[1].fix.problems.length === 1`));
  assert.equal(await page.eval(`window.__seen.some((t) => t.includes("Caffe Pedrocchi"))`), false, "the unfixed plan was never shown");
  await page.sleep(1500);
  assert.equal(await page.eval(`window.__e2e.requests.length`), 2, "no extra fix round after showing it");
});

test("a redraw while the plan is generated or fixed (weather, map lookups, an edit) doesn't break it", async () => {
  await trip({ ...PADUA_MILANO, autoFix: true });
  await page.eval(`window.__e2e.delay = 1200; window.__e2e.answer = (b) => b.fix
    ? { summary: "Swapped.", totalEstimatedCost: 0, days: [day("2027-09-17", "Milano", [stop("13:00", "Luini")])] }
    : { summary: "Plan", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")]),
        day("2027-09-17", "Milano", [stop("13:00", "Caffe Pedrocchi")])] }`);
  // Redraws of the itinerary area while it plans and while it checks (like weather or lookups arriving).
  const redraw = () => page.eval(`document.querySelector('.stay [data-k="hotel"]').dispatchEvent(new Event("change", { bubbles: true }))`);
  await page.eval(`document.querySelector("#generate").click()`);
  for (let i = 0; i < 3; i++) { await page.sleep(300); await redraw(); }
  await page.waitFor(`window.__e2e.requests.length === 1 && /Checking the plan/.test(document.querySelector("[data-gen-status]")?.textContent || "")`, 15000, "the checks");
  await redraw(); await page.sleep(200); await redraw();
  await page.waitFor(`window.__e2e.requests.length === 2 && !!document.querySelector("#output .loading")`, 30000, "the fix round, still showing progress");
  await redraw();
  await page.waitFor(`planner.state().itinerary?.days[1]?.items[0].place === "Luini" && !!document.querySelector("#output .day")`, 30000, "the fixed plan");
  assert.equal(await page.eval(`!!document.querySelector("#output .error")`), false, "no error instead of the plan");
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("trip-planner-v2")).itinerary.days[1].items[0].place`), "Luini", "and it's saved");
});

test("stops on the way are added between two stays, dates move, and Undo puts it back", async () => {
  await trip({ stays: [{ city: "Tunis", start: "2027-07-05", nights: 3, hotel: "" }, { city: "Cape Town", start: "2027-07-08", nights: 2, hotel: "", travel: "car", manualStart: true }],
    list: "", listChosen: true, autoFix: false });
  await page.eval(`window.__e2e.stops = { km: 12733, hours: 156, picked: "model", stops: [
    { city: "Cairo", country: "Egypt", nights: 2, why: "Pyramids" }, { city: "Nairobi", country: "Kenya", nights: 1, why: "Halfway" } ] }`);
  await page.waitFor(`!!document.querySelector('[data-stops="1"]')`);
  await page.eval(`document.querySelector('[data-stops="1"]').click()`);
  await page.eval(`(() => { const f = document.querySelector(".stops-form"); f.querySelector("select").value = "8"; f.querySelector("[data-go]").click(); })()`);
  await page.waitFor(`planner.state().stays.length === 4`);
  const stays = await page.eval(`planner.state().stays.map((s) => [s.city, s.start, s.nights, s.travel || ""])`);
  assert.deepEqual(stays, [
    ["Tunis", "2027-07-05", 3, ""], ["Cairo, Egypt", "2027-07-08", 2, "car"], ["Nairobi, Kenya", "2027-07-10", 1, "car"], ["Cape Town", "2027-07-11", 2, "car"],
  ]);
  const asked = await page.eval(`window.__e2e.stopsAsked`);
  assert.equal(asked.hoursPerDay, 8);
  assert.equal(asked.from.city, "Tunis");
  assert.equal(asked.to.city, "Cape Town");
  await page.eval(`document.querySelector("#toast button").click()`);
  assert.equal(await page.eval(`planner.state().stays.length`), 2, "Undo restores the two stays");
});

test("after an update downloads and the app restarts at once, the page reloads into it", async () => {
  await page.eval(`window.__e2e.update = {
    info: { newer: true, current: "1.0.0", latest: "1.0.1", mode: "portable", notesUrl: "https://example.com" },
    // Downloading, then straight back as the new version saying "idle" (the quick restart that used to hang at "0 MB of 0 MB").
    statuses: [{ phase: "downloading", received: 5e6, total: 3e7 }, { phase: "downloading", received: 3e7, total: 3e7 }, { phase: "idle", received: 0, total: 0 }],
  }; window.__beforeReload = true`);
  await page.eval(`localStorage.removeItem("trip-planner-update-dismissed")`);
  // The page checks for updates a few seconds after it loads.
  await page.waitFor(`!!document.querySelector("#updateBar [data-update]")`, 10000, "the update bar");
  await page.eval(`document.querySelector("#updateBar [data-update]").click()`);
  await page.waitFor(`window.__beforeReload !== true`, 15000, "the page to reload");
});

test("plan a route: describe the trip, see the stays and leg times, use them, Undo", async () => {
  await trip({ stays: [{ city: "Padua", start: "2027-09-01", nights: 2, hotel: "" }], list: "", listChosen: true, autoFix: false,
    customPlaces: [{ title: "Caffe Pedrocchi", lat: 45.4078, lng: 11.8775, custom: true }], marks: { "Caffe Pedrocchi": "must" }, how: { "Caffe Pedrocchi": "stay" } });
  await page.eval(`window.__e2e.route = { title: "Lakes and old towns", summary: "A loop.", start: "Padua", end: "Padua", startDate: "2027-09-01", nights: 4,
    stays: [{ city: "Milano", country: "Italy", nights: 2, travel: "car", why: "Duomo" }, { city: "Lucerne", country: "Switzerland", nights: 2, travel: "car", why: "Lake", dayTrips: [{ place: "Vaduz", why: "Liechtenstein" }] }],
    legs: [{ from: "Padua", to: "Milano", km: 245, hours: 2.6, tooLong: false }, { from: "Milano", to: "Lucerne", km: 230, hours: 2.9, tooLong: false, via: [{ place: "Lugano", why: "Lake town", lat: 46.0, lng: 8.95 }] },
      { from: "Lucerne", to: "Padua", km: 480, hours: 5.4, tooLong: true }] }`);
  await page.eval(`document.querySelector("#planRoute").click()`);
  assert.equal(await page.eval(`document.querySelector("#rpStart").value`), "Padua", "starts from the first stay");
  await page.eval(`(() => { document.querySelector("#rpDays").value = "5"; document.querySelector("#rpWhat").value = "lakes and old towns";
    document.querySelector("#rpStays").value = "cosy B&Bs"; document.querySelector("#rpGo").click(); })()`);
  await page.waitFor(`!document.querySelector("#rpUse").hidden`);
  const asked = await page.eval(`window.__e2e.routeAsked`);
  assert.equal(asked.days, 5);
  assert.deepEqual(asked.mustSee, [{ name: "Caffe Pedrocchi", lat: 45.408, lng: 11.877, how: "stay" }], "plans around the must-see places");
  assert.equal(asked.description, "lakes and old towns");
  assert.match(await page.eval(`document.querySelector("#routeResult").textContent`), /longer than your daily limit/);
  assert.match(await page.eval(`document.querySelector("#routeResult").textContent`), /Day trip: Vaduz/);
  assert.match(await page.eval(`document.querySelector("#routeResult").textContent`), /On the way: Lugano/);
  assert.match(await page.eval(`document.querySelector("#rpChat .rc-msg.ai").textContent`), /Lakes first, then the loop home\./, "the chat shows the route with what the model says about it");
  assert.ok(!(await page.eval(`document.querySelector("#rpSend").classList.contains("stop")`)), "the stop button only while planning");
  assert.equal(await page.eval(`document.querySelector("#rpGo").textContent`), "New route");
  // Replies in the chat change the route on screen: the model gets each route and what was said about it.
  // Typed like a person: the send button only works once there's text; Enter sends too.
  const type = (text) => page.eval(`(() => { const t = document.querySelector("#rpWhy"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); })()`);
  const reply = async (text) => { await type(text); await page.eval(`document.querySelector("#rpSend").click()`); };
  assert.ok(await page.eval(`document.querySelector("#rpSend").disabled`), "nothing to send yet");
  await type("less driving");
  assert.equal(await page.eval(`document.querySelector("#rpSend").disabled`), false);
  await page.eval(`document.querySelector("#rpWhy").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
  await page.waitFor(`window.__e2e.routeAsked.conversation.length === 1 && !document.querySelector("#rpUse").hidden`);
  let again = await page.eval(`window.__e2e.routeAsked.conversation`);
  assert.match(again[0].route, /Milano \(2 nights\) → Lucerne \(2 nights; day trips: Vaduz; on the way there: Lugano\)/);
  assert.equal(again[0].said, "less driving");
  await reply("a night by a lake");
  await page.waitFor(`window.__e2e.routeAsked.conversation.length === 2 && !document.querySelector("#rpUse").hidden`);
  again = await page.eval(`window.__e2e.routeAsked.conversation`);
  assert.deepEqual(again.map((t) => t.said), ["less driving", "a night by a lake"], "the whole conversation goes along");
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#rpChat .rc-msg.me")].map((e) => e.textContent)`), ["less driving", "a night by a lake"]);
  assert.equal(await page.eval(`document.querySelectorAll("#rpChat .rc-msg.ai").length`), 3);
  // New route: a fresh one, without the conversation.
  await page.eval(`document.querySelector("#rpGo").click()`);
  await page.waitFor(`document.querySelectorAll("#rpChat .rc-msg.ai").length === 4 && !document.querySelector("#rpUse").hidden`);
  assert.equal(await page.eval(`window.__e2e.routeAsked.conversation.length`), 0, "a new route starts the conversation again");
  assert.ok(await page.eval(`!!document.querySelector("#rpChat .rc-new")`), "marked in the chat");
  await reply("fewer stays");
  await page.waitFor(`document.querySelectorAll("#rpChat .rc-msg.ai").length === 5 && !document.querySelector("#rpUse").hidden`);
  assert.deepEqual(await page.eval(`window.__e2e.routeAsked.conversation.map((t) => t.said)`), ["fewer stays"], "only the chat since the new route goes along");
  await page.eval(`document.querySelector("#rpUse").click()`);
  const stays = await page.eval(`planner.state().stays.map((s) => [s.city, s.start, s.nights])`);
  assert.deepEqual(stays, [["Padua", "2027-09-01", 0], ["Milano, Italy", "2027-09-01", 2], ["Lucerne, Switzerland", "2027-09-03", 2], ["Padua", "2027-09-05", 0]]);
  assert.deepEqual(await page.eval(`planner.state().stays[2].dayTrips`), [{ place: "Vaduz", mode: "car" }]);
  assert.match(await page.eval(`planner.state().notes`), /Stays: cosy B&Bs/);
  assert.equal(await page.eval(`planner.state().wishes`), "lakes and old towns\nFrom the route plan: Milano: Duomo; Lucerne: Lake", "the description fills What you want to see");
  assert.equal(await page.eval(`document.querySelector("#wishes").value`), "lakes and old towns\nFrom the route plan: Milano: Duomo; Lucerne: Lake");
  assert.deepEqual(await page.eval(`[planner.state().marks.Lugano, planner.state().how.Lugano]`), ["must", "way"], "a stop on the way becomes a must-see on the way");
  await page.eval(`document.querySelector("#toast button").click()`);
  assert.deepEqual(await page.eval(`planner.state().stays.map((s) => s.city)`), ["Padua"], "Undo restores the stays");
  assert.equal(await page.eval(`planner.state().wishes || ""`), "", "and what they wanted to see");
  assert.equal(await page.eval(`planner.state().marks.Lugano || ""`), "", "and takes the stop on the way back out");
  // Reopening after using the route still shows it and the chat; Start over clears them.
  await page.eval(`document.querySelector("#planRoute").click()`);
  assert.ok(await page.eval(`!!document.querySelector("#routeResult .route-result") && !document.querySelector("#rpUse").hidden`), "the route is still there");
  assert.equal(await page.eval(`document.querySelector("#rpGo").textContent`), "New route");
  assert.equal(await page.eval(`document.querySelectorAll("#rpChat .rc-msg.me").length`), 3, "the chat is still there");
  await page.eval(`document.querySelector("#routeResult [data-fresh]").click()`);
  assert.equal(await page.eval(`document.querySelector("#rpGo").textContent + "|" + document.querySelectorAll("#rpChat .rc-msg").length + "|" + !!localStorage.getItem("trip-planner-route") + "|" + document.querySelector("#rpWhy").disabled`), "Plan the route|0|false|true");
});

test("a route saved before the chat existed can still be changed; an empty form says so instead of doing nothing", async () => {
  await page.eval(`localStorage.setItem("trip-planner-route", JSON.stringify({ tries: ["x"], reasons: ["y"], plan: { title: "Old one", summary: "", start: "Padua", end: "Padua",
    startDate: "2027-09-01", nights: 2, stays: [{ city: "Milano", country: "Italy", nights: 2, travel: "car", why: "" }], legs: [{ from: "Padua", to: "Milano", tooLong: false }, { from: "Milano", to: "Padua", tooLong: false }] } }));
    location.reload()`).catch(() => {});
  await page.waitFor("document.readyState === 'complete' && !!window.planner");
  await trip({ stays: [{ city: "Padua", start: "2027-09-01", nights: 2, hotel: "" }], list: "", listChosen: true, autoFix: false });
  await page.eval(`window.__e2e.route = { title: "Changed", summary: "", start: "Padua", end: "Padua", startDate: "2027-09-01", nights: 2,
    stays: [{ city: "Lucerne", country: "Switzerland", nights: 2, travel: "car", why: "" }], legs: [{ from: "Padua", to: "Lucerne", tooLong: false }, { from: "Lucerne", to: "Padua", tooLong: false }] }`);
  await page.eval(`document.querySelector("#planRoute").click()`);
  assert.equal(await page.eval(`document.querySelectorAll("#rpChat .rc-msg.ai").length`), 1, "the old route is the chat's first message");
  const send = (text) => page.eval(`(() => { const t = document.querySelector("#rpWhy"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input")); document.querySelector("#rpSend").click(); })()`);
  await send("more lakes");
  assert.match(await page.eval(`document.querySelector("#rpLive").textContent`), /Fill in the form/, "says what's missing");
  await page.eval(`document.querySelector("#rpWhat").value = "lakes"`);
  await page.eval(`document.querySelector("#rpSend").click()`);
  await page.waitFor(`document.querySelectorAll("#rpChat .rc-msg.ai").length === 2`);
  assert.deepEqual(await page.eval(`window.__e2e.routeAsked.conversation.map((t) => [t.route, t.said])`), [["Milano (2 nights)", "more lakes"]]);
  assert.equal(await page.eval(`JSON.parse(localStorage.getItem("trip-planner-route")).form.rpWhat`), "lakes", "the form is saved with the route");
});

test("trains follow the tracks: a train leg and a train day trip ask for train routes; stays link to Google Maps", async () => {
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 3, hotel: "", dayTrips: [{ place: "Venice", mode: "train" }] },
    { city: "Milano", start: "2027-09-17", nights: 2, hotel: "", travel: "train" }], list: "", listChosen: true, autoFix: false });
  await page.waitFor(`(window.__e2e.routeModes || []).filter((m) => m === "train").length >= 2`, 10000, "train routes asked for");
  const link = await page.eval(`(() => { const a = document.querySelector(".stay a.stay-geo"); return a && [a.href, a.target]; })()`);
  assert.ok(link, "the location line is a link");
  assert.match(link[0], /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Padua/);
  assert.equal(link[1], "_blank");
});

test("a must-see that isn't from a place list can be removed with its x, and Undo brings it back", async () => {
  await trip({ ...PADUA_MILANO, marks: { "Caffe Pedrocchi": "must" } });
  assert.ok(await page.eval(`!!document.querySelector('.place-row[data-t="Caffe Pedrocchi"] [data-remove]')`), "the x is there");
  await page.eval(`document.querySelector('.place-row[data-t="Caffe Pedrocchi"] [data-remove]').click()`);
  assert.equal(await page.eval(`!!document.querySelector('.place-row[data-t="Caffe Pedrocchi"]')`), false, "the row is gone");
  assert.equal(await page.eval(`planner.state().customPlaces.length + "|" + (planner.state().marks["Caffe Pedrocchi"] || "")`), "0|");
  await page.eval(`document.querySelector("#toast button").click()`);
  assert.equal(await page.eval(`planner.state().marks["Caffe Pedrocchi"]`), "must", "Undo puts it back");
});

test("setting a must-see to 'on the way' takes it off the stays' day trips", async () => {
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 3, hotel: "", dayTrips: [{ place: "Caffe Pedrocchi, Italy", mode: "car" }] }],
    list: "", listChosen: true, autoFix: false, customPlaces: [{ title: "Caffe Pedrocchi", lat: 45.4078, lng: 11.8775, custom: true }], marks: { "Caffe Pedrocchi": "must" } });
  await page.eval(`(() => { const s = document.querySelector('.place-row[data-t="Caffe Pedrocchi"] select[data-how]'); s.value = "way"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  assert.equal(await page.eval(`planner.state().how["Caffe Pedrocchi"]`), "way");
  assert.deepEqual(await page.eval(`planner.state().stays[0].dayTrips`), [], "no longer a day trip");
  assert.match(await page.eval(`document.querySelector("#toast").textContent`), /no longer a day trip from Padua/);
});

test("a must-see kept from a list that isn't selected has an x too", async () => {
  await trip({ ...PADUA_MILANO, customPlaces: [], marks: { "Rifugio Lagazuoi": "must" }, kept: [{ title: "Rifugio Lagazuoi", lat: 46.53, lng: 12.0 }] });
  assert.ok(await page.eval(`!!document.querySelector('.place-row[data-t="Rifugio Lagazuoi"] [data-remove]')`), "the x is there");
  await page.eval(`document.querySelector('.place-row[data-t="Rifugio Lagazuoi"] [data-remove]').click()`);
  assert.equal(await page.eval(`(planner.state().kept || []).length + "|" + (planner.state().marks["Rifugio Lagazuoi"] || "")`), "0|");
  await page.eval(`document.querySelector("#toast button").click()`);
  assert.equal(await page.eval(`planner.state().kept.length`), 1, "Undo keeps it again");
});

test("re-planning a day shows its progress in that day, keeps the rest, and says when it's done", async () => {
  await trip(PADUA_MILANO);
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [
    day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")]), day("2027-09-15", "Padua", [stop("10:00", "Basilica")]) ] } })`);
  await page.eval(`window.__e2e.delay = 1500; window.__e2e.answer = () => ({ summary: "New", totalEstimatedCost: 0, days: [day("2027-09-15", "Padua", [stop("09:00", "Orto Botanico")])] })`);
  await page.eval(`document.querySelector('[data-redo="1"]').click()`);
  await answerAsk();
  await page.waitFor(`!!document.querySelector("#day-1 .inline-progress")`);
  assert.equal(await page.eval(`document.querySelectorAll("#day-0 .item").length`), 1, "the other day stays visible");
  assert.equal(await page.eval(`!!document.querySelector("#output > .empty.loading")`), false, "no full-page progress");
  await page.waitFor(`[...document.querySelectorAll("#day-1 .item .name")].map((e) => e.textContent.trim()).join() === "Orto Botanico"`);
  assert.match(await page.eval(`document.querySelector("#toast").textContent`), /re-planned/);
  assert.equal(await page.eval(`window.__e2e.requests[0].redoDay.day`), 1);
});

test("a stop's name opens the place in the maps app by name and town, not as a bare pin", async () => {
  await trip(PADUA_MILANO);
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [
    day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni", { lat: 45.4115, lng: 11.8796 })]) ] } })`);
  const href = await page.eval(`document.querySelector("#day-0 .item a[href*='maps']")?.href || ""`);
  assert.match(decodeURIComponent(href.replace(/\+/g, " ")), /Cappella degli Scrovegni, Padua/);
  assert.doesNotMatch(href, /45\.41/, "no coordinates");
});

test("re-planning a stay shows its progress in the stay (unfolded), not up in the fix bar", async () => {
  await trip(PADUA_MILANO);
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [
    day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")]), day("2027-09-15", "Padua", [stop("10:00", "Basilica")]) ] } })`);
  await page.eval(`document.querySelector('[data-fold-stay="0"]').click()`);
  await page.eval(`window.__e2e.delay = 1500; window.__e2e.answer = () => ({ summary: "New", totalEstimatedCost: 0, days: [
    day("2027-09-14", "Padua", [stop("15:00", "Palazzo della Ragione")]), day("2027-09-15", "Padua", [stop("09:00", "Orto Botanico")])] })`);
  await page.eval(`document.querySelector('[data-replan-stay="0"]').click()`);
  await answerAsk();
  await page.waitFor(`!!document.querySelector("#day-0 .inline-progress")`);
  assert.equal(await page.eval(`document.querySelector('[data-stay-group="0"]').classList.contains("folded")`), false, "the stay unfolds");
  assert.equal(await page.eval(`document.querySelector("#day-1 .items").hidden`), true, "its other day is greyed out");
  assert.match(await page.eval(`document.querySelector("#day-1 .inline-wait")?.textContent || ""`), /Being changed together with/, "and says so");
  assert.equal(await page.eval(`document.querySelector("#fixBar").hidden`), true, "nothing up in the fix bar");
  await page.waitFor(`[...document.querySelectorAll("#day-1 .item .name")].map((e) => e.textContent.trim()).join() === "Orto Botanico"`);
  assert.equal(await page.eval(`window.__e2e.requests[0].edit.days.join()`), "0,1");
});

test("a travel day draws the drive once: no transfer pins, no long day legs", async () => {
  await trip({
    stays: [{ city: "Lucerne", start: "2027-09-18", nights: 2, hotel: "" }, { city: "Bregenz", start: "2027-09-20", nights: 3, hotel: "", travel: "car" }],
    list: "", listChosen: true, autoFix: false,
    customPlaces: [
      { title: "Cafe Luzern", lat: 47.0505, lng: 8.3093, custom: true }, { title: "Gaflei", lat: 47.144, lng: 9.5446, custom: true },
      { title: "Schattenburg", lat: 47.2378, lng: 9.6008, custom: true }, { title: "Seebuehne", lat: 47.5052, lng: 9.738, custom: true },
    ],
  });
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [
    day("2027-09-20", "Lucerne", [stop("08:00", "Cafe Luzern"), stop("09:00", "Lucerne → Gaflei (car)", { kind: "transfer" }), stop("11:00", "Gaflei"),
      stop("13:30", "Schattenburg", { transport: "Walk from the parking area, 5 min" }), stop("16:00", "Feldkirch → Bregenz"), stop("18:00", "Seebuehne", { transport: "Walk" })]) ] } })`);
  await page.waitFor(`document.querySelectorAll(".num-pin").length > 0`);
  const legs = await page.eval(`planner.dayLegs(planner.state().itinerary.days[0], planner.byTitleMap()).map((l) => [l.fromXi, l.xi, l.mode])`);
  assert.deepEqual(legs, [], "the drive (and the walk between stops on the way) isn't drawn as day legs");
  assert.equal(await page.eval(`document.querySelectorAll(".num-pin").length`), 4, "transfers have no pins");
});

test("a travel day's rides are one journey card; without them, the stays' way is offered and Use this adds it", async () => {
  await trip({
    stays: [{ city: "Osaka", start: "2027-04-01", nights: 2, hotel: "around the Garden Court Hotel" }, { city: "Hakone", start: "2027-04-03", nights: 2, hotel: "Maple Stay Hakone", travel: "train" }],
    list: "", listChosen: true, autoFix: false,
  });
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [
    day("2027-04-02", "Osaka", [stop("10:00", "Osaka Castle")]),
    day("2027-04-03", "Osaka → Hakone", [stop("09:00", "Check out & Osaka Metro to Shin-Osaka", { kind: "transfer", cost: 6 }),
      stop("12:15", "Shinkansen Shin-Osaka to Odawara", { kind: "sight", cost: 282 }), stop("14:30", "Uber Odawara → Maple Stay Hakone", { kind: "transfer", cost: 125 }),
      stop("16:13", "Arrive Maple Stay Hakone – check in"), stop("17:00", "Rest at the hotel")]) ] } })`);
  await page.waitFor(`!!document.querySelector(".journey")`);
  const card = await page.eval(`(() => { const j = document.querySelector(".journey"); return { head: j.querySelector(".journey-head").textContent.replace(/\\s+/g, " ").trim(),
    ends: [...j.querySelectorAll(".journey-end")].map((e) => e.textContent.trim()), stops: [...j.querySelectorAll(".item .name a")].map((a) => a.textContent) }; })()`);
  assert.match(card.head, /Osaka → Hakone/);
  assert.match(card.head, /09:00 → 16:13/);
  assert.deepEqual(card.ends, ["Leave Garden Court Hotel", "Arrive at Maple Stay Hakone"]);
  assert.equal(card.stops.length, 4, "check-out, Shinkansen, Uber and check-in are in the card; resting at the hotel isn't");
  assert.equal(await page.eval(`document.querySelector('[data-i="1"] > .items > .item .name a').textContent`), "Rest at the hotel");
  // "Rest at the hotel" after the journey is at the new stay (Hakone), not the one they left that morning.
  const rest = await page.eval(`(() => { const d = planner.state().itinerary.days[1]; const l = planner.itemLoc(d.items[4], d, planner.byTitleMap()); return l && [l.lat, l.lng]; })()`);
  assert.ok(rest && Math.abs(rest[0] - 35.2324) < 0.05 && Math.abs(rest[1] - 139.1069) < 0.05, `at Hakone, not Osaka: ${JSON.stringify(rest)}`);
  if (process.env.E2E_SHOTS) await page.screenshot(`${process.env.E2E_SHOTS}/journey.png`, ".journey");

  // The same day with no rides written in: the way between the stays is suggested, and Use this puts it in the day.
  const key = await page.eval(`(() => { const [a, b] = planner.state().stays.map((s) => planner.stayLoc(s)); return { a: [a.lat, a.lng], b: [b.lat, b.lng] }; })()`);
  await page.eval(`planner.routes["train:" + ${JSON.stringify(key.a)}.map((n) => n.toFixed(5)).join(",") + ">" + ${JSON.stringify(key.b)}.map((n) => n.toFixed(5)).join(",")] = { d: 452000, t: 11220, c: [${JSON.stringify(key.a)}, ${JSON.stringify(key.b)}],
      rides: [{ mode: "HIGHSPEED_RAIL", line: "Hikari 650", on: { n: "Shin-Osaka", lat: 34.733, lng: 135.5 }, off: { n: "Odawara", lat: 35.256, lng: 139.155 }, stops: [], dep: "11:15", to: "Tokyo" },
        { mode: "BUS", line: "H", on: { n: "Odawara", lat: 35.256, lng: 139.155 }, off: { n: "Moto-Hakone", lat: 35.2, lng: 139.03 }, stops: [], dep: "13:40", to: "Moto-Hakone" }] };
    const s = planner.state(); s.itinerary.days[1].items = [stop("17:00", "Rest at the hotel")]; planner.applyState(s)`);
  await page.waitFor(`!!document.querySelector(".journey.suggested [data-journey-use]")`);
  assert.match(await page.eval(`document.querySelector(".journey.suggested").textContent`), /Hikari 650: Shin-Osaka → Odawara/);
  if (process.env.E2E_SHOTS) await page.screenshot(`${process.env.E2E_SHOTS}/journey-suggested.png`, ".journey.suggested");
  await page.eval(`document.querySelector("[data-journey-use]").click()`);
  await page.waitFor(`!document.querySelector(".journey.suggested") && !!document.querySelector(".journey")`);
  assert.deepEqual(await page.eval(`planner.state().itinerary.days[1].items.map((x) => x.time + " " + x.place)`),
    ["11:15 High-speed train Hikari 650 Shin-Osaka → Odawara", "13:40 Bus H Odawara → Moto-Hakone", "17:00 Rest at the hotel"]);
});

test("a stay can be put on its exact spot by hand, and back on its address", async () => {
  await trip({
    stays: [{ city: "Osaka", start: "2027-04-01", nights: 2, hotel: "" }, { city: "Hakone", start: "2027-04-03", nights: 2, hotel: "Maple Stay Hakone", travel: "train" }],
    list: "", listChosen: true, autoFix: false,
  });
  await page.waitFor(`!!document.querySelector('.stay[data-i="1"] [data-act="pin"]')`);
  assert.match(await page.eval(`document.querySelector('.stay[data-i="1"] [data-act="pin"]').textContent`), /Set on the map/);
  // As if picked: the stay is there from now on (its pin, the journey, the planner).
  await page.eval(`(() => { const s = planner.state(); s.stays[1].pin = { lat: 35.2001, lng: 139.0298, label: "Maple STAY Hakone, Route 1" }; planner.applyState(s); })()`);
  await page.waitFor(`/set by hand/.test(document.querySelector('.stay[data-i="1"] .stay-where').textContent)`);
  assert.deepEqual(await page.eval(`(() => { const l = planner.stayLoc(planner.state().stays[1]); return [l.lat, l.lng, l.cc]; })()`), [35.2001, 139.0298, "jp"]);
  await page.eval(`document.querySelector('.stay[data-i="1"] [data-act="pin"]').click()`);
  await page.waitFor(`!!document.querySelector('.stay[data-i="1"] .pin-panel [data-pin-extra]')`);
  assert.match(await page.eval(`document.querySelector('.stay[data-i="1"] .pin-panel input').value`), /^Maple Stay Hakone$/);
  await page.eval(`document.querySelector('.stay[data-i="1"] .pin-panel [data-pin-extra]').click()`);
  await page.waitFor(`!planner.state().stays[1].pin`);
  assert.deepEqual(await page.eval(`(() => { const l = planner.stayLoc(planner.state().stays[1]); return [l.lat, l.lng]; })()`), [35.2324, 139.1069], "back to the town's spot");
});

test("a stop's edit window changes everything about it at once; Cancel changes nothing", async () => {
  await trip({ ...PADUA_MILANO, travelers: 2 });
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [
    stop("09:00", "Caffè Pedrocchi", { kind: "meal", cost: 12, lat: 45.4077, lng: 11.8766, pinned: true }), stop("10:30", "Cappella degli Scrovegni", { kind: "sight", cost: 30, transport: "Walk 10 min", lat: 45.4115, lng: 11.8795, pinned: true })])] } })`);
  await page.waitFor(`!!document.querySelector('[data-edit="0-1"]')`);
  await page.eval(`document.querySelector('[data-edit="0-1"]').click()`);
  await page.waitFor(`!!document.querySelector("dialog.stop-edit[open]")`);
  if (process.env.E2E_SHOTS) await page.screenshot(`${process.env.E2E_SHOTS}/stop-edit.png`, "dialog.stop-edit");
  // Cancel: nothing changes.
  await page.eval(`(() => { const d = document.querySelector("dialog.stop-edit"); d.querySelector('[data-f="place"]').value = "Changed"; d.querySelector("[data-se-cancel]").click(); })()`);
  await page.waitFor(`!document.querySelector("dialog.stop-edit")`);
  assert.equal(await page.eval(`planner.state().itinerary.days[0].items[1].place`), "Cappella degli Scrovegni");
  // The route button opens it too, at how they get here; set by hand to a train, with everything else changed.
  await page.eval(`document.querySelector('[data-leg-edit="0-1"]').click()`);
  await page.waitFor(`!!document.querySelector("dialog.stop-edit[open] .lp-how")`);
  if (process.env.E2E_SHOTS) await page.screenshot(`${process.env.E2E_SHOTS}/stop-edit-leg.png`, "dialog.stop-edit .se-section");
  await page.eval(`(() => { const d = document.querySelector("dialog.stop-edit"), f = (k, v) => { const e = d.querySelector('[data-f="' + k + '"]'); e.value = v; };
    f("time", "11:15"); f("place", "Scrovegni Chapel"); f("description", "Giotto's frescoes."); f("cost", "34"); f("costPer", "person");
    f("booking", "essential"); f("bookAhead", "1 week before"); f("transport", "Tram to Eremitani"); f("group", "Group A"); f("people", "1");
    const hand = d.querySelector('.lp-how input[value="hand"]'); hand.checked = true; hand.dispatchEvent(new Event("change")); })()`);
  await page.waitFor(`!document.querySelector("dialog.stop-edit .lp-hand").hidden`);
  await page.eval(`(() => { const s = document.querySelector('dialog.stop-edit [data-mode="0"]'); s.value = "transit"; s.dispatchEvent(new Event("change")); document.querySelector("dialog.stop-edit [data-se-save]").click(); })()`);
  await page.waitFor(`!document.querySelector("dialog.stop-edit")`);
  const x = await page.eval(`planner.state().itinerary.days[0].items[1]`);
  assert.deepEqual([x.time, x.place, x.description, x.cost, x.costPer, x.booking, x.bookAhead, x.transport, x.group, x.people, x.leg.modes],
    ["11:15", "Scrovegni Chapel", "Giotto's frescoes.", 34, "person", "essential", "1 week before", "Tram to Eremitani", "Group A", 1, ["transit"]]);
  assert.equal(await page.eval(`planner.state().itinerary.days[0].estimatedCost`), 46, "the day's cost follows");
  // Back to automatic: the hand-set way goes.
  await page.eval(`document.querySelector('[data-edit="0-1"]').click()`);
  await page.waitFor(`!!document.querySelector("dialog.stop-edit[open]")`);
  await page.eval(`(() => { const a = document.querySelector('dialog.stop-edit .lp-how input[value="auto"]'); a.checked = true; a.dispatchEvent(new Event("change")); document.querySelector("dialog.stop-edit [data-se-save]").click(); })()`);
  await page.waitFor(`!document.querySelector("dialog.stop-edit")`);
  assert.equal(await page.eval(`planner.state().itinerary.days[0].items[1].leg`), undefined);
});

test("links in the app's own window go to the default browser", async () => {
  await page.eval(`sessionStorage.setItem("trip-planner-app-window", "1"); location.reload()`);
  await page.waitFor("document.readyState === 'complete' && !!window.planner");
  await trip(PADUA_MILANO);
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")])] } })`);
  await page.eval(`document.querySelector(".item .name a").click()`);
  await page.waitFor(`window.__e2e.open.length === 1`);
  assert.match(await page.eval(`window.__e2e.open[0]`), /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Cappella/);
});

test("book ahead links hotels and transport; the packing list fits the countries (each in its window from the toolbar)", async () => {
  await trip({
    stays: [{ city: "Osaka", start: "2027-04-01", nights: 3, hotel: "around the Garden Court Hotel" }, { city: "Kyoto", start: "2027-04-04", nights: 2, hotel: "", travel: "train" }],
    list: "", listChosen: true, travelers: 2, autoFix: false,
  });
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [
    day("2027-04-01", "Osaka", [stop("15:00", "Osaka Castle")]), day("2027-04-02", "Osaka", [stop("10:00", "Onsen Spa World")]) ] } })`);
  await page.waitFor(`!!document.querySelector('[data-section="ahead"]')`);
  await page.eval(`document.querySelector('[data-section="ahead"]').click()`);
  await page.waitFor(`document.querySelector("#sectionDialog").open && !!document.querySelector('#sectionBody .book-ahead')`);
  const links = await page.eval(`[...document.querySelectorAll('#sectionBody .book-ahead li.trip a')].map((a) => a.href)`);
  assert.equal(links.length, 3, "two hotels and one transfer");
  const hotel = new URL(links[0]);
  assert.equal(hotel.hostname, "www.booking.com");
  assert.equal(hotel.searchParams.get("ss"), "Garden Court Hotel, Osaka");
  assert.equal(hotel.searchParams.get("checkin"), "2027-04-01");
  assert.equal(hotel.searchParams.get("checkout"), "2027-04-04");
  assert.equal(hotel.searchParams.get("group_adults"), "2");
  assert.equal(hotel.searchParams.get("dest_type"), "latlong", "Booking needs a position; text alone finds nothing");
  assert.equal(Number(hotel.searchParams.get("latitude")).toFixed(2), "34.69");
  assert.ok(links.includes("https://www.rome2rio.com/map/Osaka/Kyoto"));
  await page.eval(`document.querySelector("#sectionDialog").close(); document.querySelector('[data-section="packing"]').click()`);
  const packing = await page.eval(`document.querySelector('#sectionBody .packing').textContent`);
  await page.eval(`document.querySelector("#sectionDialog").close()`);
  assert.match(packing, /Cash in yen/);
  assert.match(packing, /Japan A\/B/);
  assert.match(packing, /Swimwear/, "the spa in the plan");
});

test("the theme is chosen in Settings (light, dark, system), and the header only has the settings button", async () => {
  assert.equal(await page.eval(`!!document.querySelector("#themeBtn") || !!document.querySelector("header .window-mode")`), false, "no theme button or window switch in the header");
  await page.eval(`document.querySelector("#settingsBtn").click()`);
  await page.waitFor(`!!document.querySelector('[data-theme-choice="light"]')`);
  const pick = async (c) => { await page.eval(`document.querySelector('[data-theme-choice="${c}"]').click()`); return page.eval(`(localStorage.getItem("trip-planner-theme") || "system") + ":" + document.documentElement.dataset.theme`); };
  assert.equal(await pick("light"), "light:light");
  assert.equal(await pick("dark"), "dark:dark");
  assert.match(await pick("system"), /^system:(light|dark)$/);
  await page.eval(`document.querySelector("#settingsDialog").close()`);
});

test("Settings → Planning saves the options, and fix rounds take effect in the page", async () => {
  await page.eval(`document.querySelector("#settingsBtn").click()`);
  await page.waitFor(`!!document.querySelector('[data-tab="planning"]')`);
  await page.eval(`document.querySelector('[data-tab="planning"]').click()`);
  await page.waitFor(`!!document.querySelector('[data-tune="detail"]')`, 10000, "planning tab");
  await page.eval(`document.querySelector('[data-tune="detail"][data-v="brief"]').click()`);
  await page.waitFor(`document.querySelector('[data-tune="detail"][data-v="brief"]').classList.contains("on")`);
  await page.eval(`document.querySelector('[data-tune="fixRounds"][data-v="2"]').click()`);
  await page.waitFor(`document.querySelector('[data-tune="fixRounds"][data-v="2"]').classList.contains("on")`);
  await page.eval(`(() => { const l = document.querySelector("#tuneLang"); l.value = "Deutsch"; l.dispatchEvent(new Event("change")); })()`);
  await page.sleep(400);
  const s = await page.eval(`fetch("/api/settings").then((r) => r.json())`);
  assert.deepEqual([s.tune.detail, s.tune.fixRounds, s.tune.language], ["brief", 2, "Deutsch"]);
  // Back to the defaults for the other tests.
  await page.eval(`fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tune: { detail: "normal", fixRounds: 1, language: "" } }) })`);
  await page.eval(`document.querySelector("#settingsDialog").close()`);
});

test("'doesn't match your stays' only when the stays changed since the plan (not for 'Padua, Italy' vs 'Padua')", async () => {
  await trip({ stays: [{ city: "Padua, Italy", start: "2027-09-14", nights: 2, hotel: "" }], list: "", listChosen: true, autoFix: false });
  await page.eval(`window.__e2e.answer = () => ({ summary: "Plan", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [stop("10:00", "Basilica")]),
    day("2027-09-15", "Padua", [stop("10:00", "Orto Botanico")]), day("2027-09-16", "Padua", [stop("10:00", "Caffe Pedrocchi")])] })`);
  await page.eval(`document.querySelector("#generate").click()`);
  await page.waitFor(`!!document.querySelector("#output .day")`, 20000, "the plan");
  assert.equal(await page.eval(`!!document.querySelector("#output .stale")`), false, "no warning for the stays it was made for");
  await page.eval(`(() => { const n = document.querySelector('.stay [data-k="nights"]'); n.value = "3"; n.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  assert.ok(await page.eval(`!!document.querySelector("#output .stale")`), "the warning once the stays change");
});

test("settings open with their tabs: general, local models, phone", async () => {
  await page.eval(`document.querySelector("#settingsBtn").click()`);
  await page.waitFor(`document.querySelector("#settingsDialog").open && /Theme/.test(document.querySelector("#setMain").textContent)`, 10000, "general tab");
  await page.eval(`document.querySelector('[data-theme-choice="dark"]').click()`);
  assert.equal(await page.eval(`document.documentElement.dataset.theme`), "dark");
  await page.eval(`document.querySelector('[data-tab="phone"]').click()`);
  assert.match(await page.eval(`document.querySelector("#setMain").textContent`), /Phone access is off/);
  await page.eval(`document.querySelector('[data-tab="models"]').click()`);
  await page.waitFor(`/Ollama/.test(document.querySelector("#setMain .status")?.textContent || "")`, 20000, "local models tab");
  await page.eval(`document.querySelector('[data-theme-choice="system"]')?.click(); localStorage.removeItem("trip-planner-theme")`);
});

test("the trip chat answers from the trip, keeps the conversation, and reads the ideas notes", async () => {
  await trip({ ...PADUA_MILANO, itinerary: { summary: "Plan", totalEstimatedCost: 0, days: [
    { date: "2027-09-14", city: "Padua", title: "Padua", estimatedCost: 0, items: [{ time: "15:00", place: "Cappella degli Scrovegni", description: "Giotto frescoes" }] },
    { date: "2027-09-15", city: "Padua", title: "Padua", estimatedCost: 0, items: [{ time: "10:00", place: "Basilica", description: "" }] }] } });
  await page.eval(`(() => { const t = document.querySelector("#ideas"); t.value = "Maybe a boat on the Brenta?"; t.dispatchEvent(new Event("input")); })()`);
  await page.eval(`document.querySelector("#chatBtn").click()`);
  assert.ok(await page.eval(`!document.querySelector("#chatPanel").hidden && document.body.classList.contains("chat-open")`));
  await page.eval(`document.querySelector("#cpLog [data-q]").click()`);
  await page.waitFor(`document.querySelectorAll("#cpLog .rc-msg.ai:not(.pending)").length === 1`, 10000, "the answer");
  const asked = await page.eval(`window.__e2e.companionAsked`);
  assert.match(asked.context, /Day 1 .*Padua/);
  assert.match(asked.context, /Cappella degli Scrovegni: Giotto frescoes/);
  assert.match(asked.context, /boat on the Brenta/);
  assert.match(await page.eval(`document.querySelector("#cpLog .rc-msg.ai").innerHTML`), /<b>day 2<\/b>/);
  // A follow-up carries the conversation.
  await page.eval(`(() => { const q = document.querySelector("#cpQ"); q.value = "And day 3?"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`document.querySelectorAll("#cpLog .rc-msg.ai:not(.pending)").length === 2`, 10000, "the second answer");
  assert.equal((await page.eval(`window.__e2e.companionAsked.history`)).length, 2);
  assert.equal(await page.eval(`planner.state().chat.length`), 4);
  assert.equal(await page.eval(`planner.state().ideas`), "Maybe a boat on the Brenta?");
});

test("asking the chat for a change offers it; Apply changes only that day, Undo puts the plan back", async () => {
  const plan = { summary: "Plan", totalEstimatedCost: 0, days: [
    { date: "2027-09-14", city: "Padua", title: "Padua", estimatedCost: 0, items: [{ time: "10:00", place: "Basilica", description: "" }] },
    { date: "2027-09-15", city: "Padua", title: "Padua", estimatedCost: 0, items: [{ time: "10:00", place: "Orto Botanico", description: "" }] }] };
  await trip({ ...PADUA_MILANO, itinerary: plan });
  await page.eval(`window.__e2e.companion = { answer: "I'll swap the botanical garden for a market morning.", change: { days: [2], request: "Day 2: replace Orto Botanico with a morning at the market" } };
    window.__e2e.answer = (b) => ({ summary: "Day", totalEstimatedCost: 0, days: [day("2027-09-15", "Padua", [stop("09:00", "Mercato")])] })`);
  // "Ask for changes" under the plan opens the chat.
  await page.eval(`document.querySelector("#refineBtn").click()`);
  assert.equal(await page.eval(`document.activeElement.id`), "cpQ");
  await page.eval(`(() => { const q = document.querySelector("#cpQ"); q.value = "Less garden, more food on day 2"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`!!document.querySelector("#cpLog [data-apply]")`, 10000, "the offered change");
  assert.equal(await page.eval(`window.__e2e.companionAsked.days`), 2);
  assert.match(await page.eval(`document.querySelector(".cp-change").textContent`), /Changes day 2 only/);
  await page.eval(`document.querySelector("#cpLog [data-apply]").click()`);
  await page.waitFor(`!!document.querySelector("#cpLog [data-undo]")`, 15000, "the change applied");
  const sent = await page.eval(`window.__e2e.requests.at(-1)`);
  assert.deepEqual(sent.edit.days, [1], "only day 2 is sent to be changed");
  assert.match(sent.edit.request, /morning at the market/);
  assert.equal(sent.research, false);
  assert.equal(await page.eval(`planner.state().itinerary.days[1].items[0].place`), "Mercato");
  assert.equal(await page.eval(`planner.state().itinerary.days[0].items[0].place`), "Basilica", "the other day stays");
  await page.eval(`document.querySelector("#cpLog [data-undo]").click()`);
  assert.equal(await page.eval(`planner.state().itinerary.days[1].items[0].place`), "Orto Botanico");
  assert.match(await page.eval(`document.querySelector(".cp-change").textContent`), /Undone/);
  await page.eval(`document.querySelector("#cpClose").click(); window.__e2e.companion = null`);
});

test("place lists: ticked ones show on the map; suggested ones go to the planner, from the others only the stars", async () => {
  await page.eval(`window.__e2e.lists = {
    "Italy": [{ title: "Basilica di Sant'Antonio", lat: 45.401, lng: 11.881 }, { title: "Caffe Pedrocchi", lat: 45.4078, lng: 11.8775 }],
    "Food": [{ title: "Caffe Pedrocchi", lat: 45.4078, lng: 11.8775 }, { title: "Mercato sotto il Salone", lat: 45.407, lng: 11.875 }],
  }`);
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 2, hotel: "" }], lists: ["Italy"], listChosen: true, autoFix: false });
  await page.waitFor(`document.querySelectorAll("#listPicker .list-row").length === 2`, 5000, "the lists");
  await page.waitFor(`document.querySelectorAll("#chips .place-row").length === 2`, 5000, "one list's places");
  await page.eval(`(() => { const b = document.querySelector('[data-list="Food"]'); b.checked = true; b.dispatchEvent(new Event("change")); })()`);
  await page.waitFor(`document.querySelectorAll("#chips .place-row").length === 3`, 5000, "both lists' places (Caffe Pedrocchi once)");
  assert.deepEqual(await page.eval(`planner.state().lists`), ["Italy", "Food"]);
  assert.equal(await page.eval(`document.querySelector("#listMeta").textContent`), "2 lists on the map · 2 suggested to the planner");
  await page.eval(`window.__e2e.answer = () => ({ summary: "Plan", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [stop("10:00", "Basilica")])] })`);
  await page.eval(`document.querySelector("#generate").click()`);
  await page.waitFor(`window.__e2e.requests.length === 1`, 10000, "the request");
  assert.deepEqual(await page.eval(`window.__e2e.requests[0].lists`), ["Italy", "Food"]);
  // Suggestions off: the list's places still show on the map, but only the starred ones go to the planner.
  await page.waitFor(`!document.querySelector("#generate").disabled`, 10000, "generation done");
  await page.eval(`document.querySelector("#openPlaces").click()`);
  assert.ok(await page.eval(`document.querySelector("#placesDialog").open`), "Manage places opens the Places dialog");
  await page.eval(`document.querySelector('[data-suggest="Food"]').click()`);
  await page.waitFor(`document.querySelector('[data-suggest="Food"]').getAttribute("aria-pressed") === "false"`, 5000, "suggestions off for the list");
  assert.equal(await page.eval(`document.querySelectorAll("#chips .place-row").length`), 3, "its places still show");
  await page.eval(`document.querySelector('#chips .place-row[data-t="Mercato sotto il Salone"] [data-star]').click()`);
  assert.equal(await page.eval(`planner.state().marks["Mercato sotto il Salone"]`), "must");
  await page.eval(`document.querySelector("#placesDialog").close(); document.querySelector("#generate").click()`);
  await page.waitFor(`window.__e2e.requests.length === 2`, 10000, "the second request");
  const req = await page.eval(`window.__e2e.requests[1]`);
  assert.deepEqual(req.lists, ["Italy"]);
  assert.deepEqual(req.extraPlaces.map((p) => p.title), ["Mercato sotto il Salone"], "only the starred place of the list without suggestions");
  assert.match(await page.eval(`document.querySelector("#placesSummary").textContent`), /2 lists on the map \(1 suggested[\s\S]*Mercato sotto il Salone/);
  await page.eval(`document.querySelector("#placesDialog").close()`);
  await page.eval(`window.__e2e.lists = null`);
});

test("a place's popup on the map stays open while the map redraws (lookups and routes coming in)", async () => {
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 2, hotel: "" }], list: "", listChosen: true, autoFix: false,
    customPlaces: [{ title: "Caffe Pedrocchi", lat: 45.4078, lng: 11.8775, custom: true }] });
  await page.waitFor(`!!document.querySelector(".leaflet-overlay-pane path.leaflet-interactive")`, 5000, "the place's dot");
  await page.eval(`document.querySelector(".leaflet-overlay-pane path.leaflet-interactive").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }))`);
  await page.waitFor(`/Caffe Pedrocchi/.test(document.querySelector(".leaflet-popup")?.textContent || "")`, 5000, "the popup");
  await page.eval(`planner.drawMap(); planner.drawMap()`);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(await page.eval(`document.querySelector(".leaflet-popup")?.textContent || ""`), /Caffe Pedrocchi/, "still open after redraws");
  // Its buttons still work: Must-see closes it and marks the place.
  await page.eval(`document.querySelector('.leaflet-popup [data-mark][data-v="must"]').click()`);
  assert.equal(await page.eval(`planner.state().marks["Caffe Pedrocchi"]`), "must");
});

test("the chat can move a stop to where it really is (its address looked up), and Undo puts it back", async () => {
  const plan = { summary: "Plan", totalEstimatedCost: 0, days: [
    { date: "2027-09-14", city: "Padua", title: "Padua", estimatedCost: 0, items: [{ time: "10:00", place: "Basilica", description: "", lat: 45.40, lng: 11.88 }] }] };
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 1, hotel: "" }], list: "", listChosen: true, autoFix: false, itinerary: plan });
  // (The server looked the address up: the page gets the spot with the change.)
  await page.eval(`window.__e2e.companion = { answer: "Moved it to the address you gave.", change: { days: [], request: "", stops: [{ op: "where", day: 1, place: "Basilica", where: "Piazza del Santo, Padova", lat: 45.4013, lng: 11.8809 }] } }`);
  await page.eval(`document.querySelector("#chatBtn").click(); (() => { const q = document.querySelector("#cpQ"); q.value = "the basilica is at Piazza del Santo"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`!!document.querySelector("#cpLog [data-apply]")`, 10000, "the offered change");
  assert.match(await page.eval(`document.querySelector(".cp-change").textContent`), /Basilica is at Piazza del Santo/);
  await page.eval(`document.querySelector("#cpLog [data-apply]").click()`);
  await page.waitFor(`!!document.querySelector("#cpLog [data-undo]")`, 10000, "applied");
  const x = await page.eval(`planner.state().itinerary.days[0].items[0]`);
  assert.deepEqual([x.lat, x.lng, x.pinned, x.time], [45.4013, 11.8809, true, "10:00"], "moved, trusted, nothing else changed");
  assert.equal(await page.eval(`window.__e2e.requests.length`), 0, "no new plan asked for");
  await page.eval(`document.querySelector("#cpLog [data-undo]").click()`);
  assert.deepEqual(await page.eval(`(({ lat, lng }) => [lat, lng])(planner.state().itinerary.days[0].items[0])`), [45.40, 11.88], "Undo puts it back");
  await page.eval(`document.querySelector("#cpClose").click(); window.__e2e.companion = null`);
});

test("the chat can set a place on the way (taking it off the stay's day trips); Undo puts it back; old cards lose their buttons", async () => {
  const plan = { summary: "Plan", totalEstimatedCost: 0, days: [
    { date: "2027-09-14", city: "Padua", title: "Padua", estimatedCost: 0, items: [{ time: "10:00", place: "Basilica", description: "" }] }] };
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 3, hotel: "", dayTrips: [{ place: "Caffe Pedrocchi, Italy", mode: "car" }] }],
    list: "", listChosen: true, autoFix: false, itinerary: plan, customPlaces: [{ title: "Caffe Pedrocchi", lat: 45.4078, lng: 11.8775, custom: true }] });
  await page.eval(`window.__e2e.companion = { answer: "It'll be a stop on the way instead.", change: { days: [], request: "", trip: { onTheWay: ["Caffe Pedrocchi"] } } }`);
  await page.eval(`document.querySelector("#chatBtn").click(); (() => { const q = document.querySelector("#cpQ"); q.value = "Pedrocchi on the way please"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`!!document.querySelector("#cpLog [data-apply]")`, 10000, "the offered change");
  assert.match(await page.eval(`document.querySelector(".cp-change").textContent`), /Caffe Pedrocchi: on the way between stays/);
  await page.eval(`document.querySelector("#cpLog [data-apply]").click()`);
  await page.waitFor(`!!document.querySelector("#cpLog [data-undo]")`, 10000, "applied");
  assert.deepEqual(await page.eval(`planner.state().stays[0].dayTrips`), [], "no longer a day trip");
  assert.equal(await page.eval(`planner.state().how["Caffe Pedrocchi"]`), "way");
  assert.equal(await page.eval(`planner.state().marks["Caffe Pedrocchi"]`), "must");
  assert.equal(await page.eval(`window.__e2e.requests.length`), 0, "the days were already right: no new plan asked for");
  // Writing again: the old card shows how it went, without buttons.
  await page.eval(`window.__e2e.companion = { answer: "Sure, noted." }; (() => { const q = document.querySelector("#cpQ"); q.value = "thanks"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`document.querySelectorAll("#cpLog .rc-msg.ai:not(.pending)").length === 2`, 10000, "the second answer");
  assert.equal(await page.eval(`document.querySelectorAll("#cpLog [data-undo], #cpLog [data-apply]").length`), 0, "no buttons on the old card");
  assert.match(await page.eval(`document.querySelector(".cp-change").textContent`), /Applied/);
  assert.match(await page.eval(`JSON.stringify(window.__e2e.companionAsked.history)`), /Change applied: Caffe Pedrocchi: on the way/);
  // A further change carries the series: its Undo puts back both.
  await page.eval(`window.__e2e.companion = { answer: "And a day trip to Venice.", change: { days: [], request: "", trip: { addDayTrips: [{ stay: "Padua", place: "Venice", mode: "train" }] } } };
    (() => { const q = document.querySelector("#cpQ"); q.value = "add venice as a day trip"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`!!document.querySelector("#cpLog [data-apply]")`, 10000, "the second change");
  await page.eval(`document.querySelector("#cpLog [data-apply]").click()`);
  await page.waitFor(`/Undo all 2 changes/.test(document.querySelector("#cpLog [data-undo]")?.textContent || "")`, 10000, "undo for both");
  assert.equal(await page.eval(`planner.state().stays[0].dayTrips[0].place`), "Venice");
  await page.eval(`document.querySelector("#cpLog [data-undo]").click()`);
  assert.equal(await page.eval(`planner.state().stays[0].dayTrips[0].place`), "Caffe Pedrocchi, Italy", "back to before the first change");
  assert.equal(await page.eval(`planner.state().how?.["Caffe Pedrocchi"] || ""`), "");
  await page.eval(`document.querySelector("#cpClose").click(); window.__e2e.companion = null`);
});

test("a long chat is compacted: the older messages are summarized and the summary is sent instead", async () => {
  // Compacting goes by size: 18 messages of ~900 tokens are over the 12,000 (18 short ones aren't).
  const chat = Array.from({ length: 18 }, (_, k) => ({ role: k % 2 ? "ai" : "me", text: `message ${k} ${"lorem ipsum ".repeat(300)}` }));
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 2, hotel: "" }], list: "", listChosen: true, autoFix: false, chat });
  await page.eval(`window.__e2e.companion = { answer: "Noted." }; document.querySelector("#chatBtn").click();
    (() => { const q = document.querySelector("#cpQ"); q.value = "one more"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`planner.state().chat.length === 20`, 10000, "the answer");
  const asked = await page.eval(`window.__e2e.compactAsked`);
  assert.equal(asked.turns.length, 12, "the 18 messages minus the 6 most recent");
  assert.equal(await page.eval(`planner.state().chatSummarized`), 12);
  const sent = await page.eval(`window.__e2e.companionAsked`);
  assert.equal(sent.summary, "- They want Pedrocchi on the way.");
  assert.match(sent.history[0].text, /^message 12 /, "only what came after the summary");
  assert.ok(await page.eval(`!!document.querySelector("#cpLog .cp-summary")`), "a marker where the summary ends");
  await page.eval(`document.querySelector("#cpClose").click(); window.__e2e.companion = null`);
});

test("Retry asks the last message again, replacing its answer", async () => {
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 2, hotel: "" }], list: "", listChosen: true, autoFix: false, chat: [] });
  await page.eval(`window.__e2e.companion = { answer: "First answer." }; document.querySelector("#chatBtn").click();
    (() => { const q = document.querySelector("#cpQ"); q.value = "where to eat?"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`planner.state().chat.length === 2`, 10000, "the answer");
  await page.eval(`window.__e2e.companion = { answer: "Second answer." }; window.__e2e.companionAsked = null; document.querySelector("#cpLog [data-retry]").click()`);
  await page.waitFor(`planner.state().chat.at(-1)?.text === "Second answer."`, 10000, "the new answer");
  assert.equal(await page.eval(`planner.state().chat.length`), 2, "replaced, not added");
  assert.equal(await page.eval(`window.__e2e.companionAsked.question`), "where to eat?");
  await page.eval(`document.querySelector("#cpClose").click(); window.__e2e.companion = null`);
});

test("a leg left to the planner shows (and draws) the mode the plan picked", async () => {
  const transfer = { time: "10:00", place: "Padua → Milano (train)", description: "", cost: 20, kind: "transfer", transport: "Frecciarossa, 2 h" };
  await trip({ ...PADUA_MILANO, stays: [PADUA_MILANO.stays[0], { ...PADUA_MILANO.stays[1], travel: "" }], itinerary: {
    summary: "", totalEstimatedCost: 20, days: [{ date: "2027-09-16", city: "Padua → Milano", title: "", estimatedCost: 20, items: [transfer] }] } });
  await page.waitFor(`/Planner decides \\(train\\)/.test(document.querySelector(".stay-leg select").selectedOptions[0].textContent)`, 5000, "the planned mode in the menu");
  assert.equal(await page.eval(`planner.state().stays[1].travel`), "", "the choice stays with the planner");
});

test("export a trip to a file and import it again (replacing the trip on screen)", async () => {
  await trip({ ...PADUA_MILANO, ideas: "Brenta boat", marks: { "Caffe Pedrocchi": "must" } });
  await page.eval(`window.__exported = null; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__exported = { name: this.download, href: this.href }; }`);
  await page.eval(`document.querySelector("#exportTrip").click()`);
  await page.waitFor(`!!window.__exported`, 5000, "the exported file");
  const file = await page.eval(`(async () => ({ name: window.__exported.name, text: await (await fetch(window.__exported.href)).text() }))()`);
  assert.match(file.name, /Padua-Milano\.trip\.json$/);
  const data = JSON.parse(file.text);
  assert.equal(data.format, "trip-planner-trip");
  assert.equal(data.trip.ideas, "Brenta boat");
  await page.eval(`planner.applyState({ stays: [{ city: "Kyoto", start: "2027-04-01", nights: 2, hotel: "" }], listChosen: true })`);
  await page.eval(`void planner.importTrip(new File([${JSON.stringify(file.text)}], "shared.trip.json"))`);
  await answerAsk();
  await page.waitFor(`planner.state().stays[0].city === "Padua"`, 10000, "the imported trip");
  assert.equal(await page.eval(`document.querySelector("#ideas").value`), "Brenta boat");
  assert.equal(await page.eval(`planner.state().marks["Caffe Pedrocchi"]`), "must");
  await page.waitFor(`document.querySelector("#saveList").value === "shared"`, 5000, "the import in the saved trips");
  // Importing the same file again keeps the first copy and saves a second one.
  await page.eval(`void planner.importTrip(new File([${JSON.stringify(file.text)}], "shared.trip.json"))`);
  await answerAsk();
  await page.waitFor(`document.querySelector("#saveList").value === "shared 2"`, 5000, "a second copy, not an overwrite");
  await page.eval(`planner.importTrip(new File(["not json"], "bad.json"))`);
  await page.waitFor(`/isn't a trip file/.test(document.querySelector("#saveStatus").textContent)`, 5000, "the error");
  assert.equal(await page.eval(`planner.state().stays[0].city`), "Padua", "a bad file changes nothing");
});

test("an imported trip brings its place lists along", async () => {
  const file = { format: "trip-planner-trip", trip: { ...PADUA_MILANO, lists: ["Shared ideas"], list: "Shared ideas" },
    lists: [{ name: "Shared ideas", title: "Shared ideas", places: [{ title: "Orto Botanico di Padova", lat: 45.3994, lng: 11.8807 }] }] };
  await page.eval(`void planner.importTrip(new File([${JSON.stringify(JSON.stringify(file))}], "with-list.trip.json"))`);
  await answerAsk();
  await page.waitFor(`(planner.state().lists || []).includes("Shared ideas")`, 10000, "the list ticked");
  const list = await page.eval(`fetch("/api/lists/Shared%20ideas").then((r) => r.json())`);
  assert.equal(list.places[0].title, "Orto Botanico di Padova");
  await page.eval(`fetch("/api/lists/Shared%20ideas", { method: "DELETE" })`);
});

test("Settings → General: formats, new trips' defaults, saving new plans by themselves, starting with a new trip", async () => {
  const setApp = (app) => page.eval(`fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: ${JSON.stringify(app)} }) })`);
  try {
    await page.eval(`planner.applyState({ ...${JSON.stringify(PADUA_MILANO)}, itinerary: { summary: "", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [stop("14:30", "Cappella degli Scrovegni")])] } })`);
    await page.waitFor(`document.querySelector(".day time")?.textContent === "14:30"`, 10000, "the plan");
    await page.eval(`document.querySelector("#settingsBtn").click()`);
    await page.waitFor(`!!document.querySelector('[data-app="clock"]')`, 10000, "the general settings");
    await page.eval(`document.querySelector('[data-app="clock"][data-v="12"]').click()`);
    await page.waitFor(`document.querySelector(".day time")?.textContent === "2:30 pm"`, 5000, "12-hour times in the plan");
    await page.waitFor(`!!document.querySelector('[data-app="dates"][data-v="dmy"]')`);
    await page.eval(`document.querySelector('[data-app="dates"][data-v="dmy"]').click()`);
    await page.waitFor(`/14 Sept?/.test(document.querySelector("#day-0 .date").textContent)`, 5000, "day-first dates");
    await page.waitFor(`!!document.querySelector("#ntTravelers")`);
    await page.eval(`(() => { const t = document.querySelector("#ntTravelers"); t.value = "4"; t.dispatchEvent(new Event("change")); })()`);
    await page.waitFor(`fetch("/api/settings").then((r) => r.json()).then((s) => s.app.newTrip.travelers === 4)`, 5000, "the new-trip default saved");
    await page.eval(`document.querySelector("#settingsDialog").close()`);
    await page.eval(`document.querySelector("#newTrip").click()`);
    // A new trip asks for its name, and is saved under it.
    await answerAsk(`E2E new trip ${Date.now()}`);
    await page.waitFor(`planner.state().travelers === 4 && !planner.state().itinerary && /^E2E new trip/.test(planner.state().saveName || "")`, 5000, "a new trip with 4 travelers");

    // A new plan is saved by itself, under its cities' names.
    await setApp({ autoSave: true });
    await page.eval(`location.reload()`).catch(() => {});
    await page.waitFor("document.readyState === 'complete' && !!window.planner");
    await trip(PADUA_MILANO);
    await page.eval(`window.__e2e.answer = () => ({ summary: "Plan", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")])] })`);
    await page.eval(`document.querySelector("#generate").click()`);
    await page.waitFor(`fetch("/api/saves").then((r) => r.json()).then((l) => l.some((x) => x.name === "Padua-Milano"))`, 20000, "the plan in Saved trips");
    assert.equal(await page.eval(`planner.state().saveName`), "Padua-Milano");

    // Starting with a new trip keeps the open one in Saved trips.
    await setApp({ autoSave: false, startWith: "new" });
    await page.eval(`sessionStorage.clear(); location.reload()`).catch(() => {});
    await page.waitFor("document.readyState === 'complete' && !!window.planner");
    await page.waitFor(`!planner.state().stays[0].city && !planner.state().itinerary`, 10000, "a new trip on start");
  } finally {
    await setApp({ units: "km", clock: "24", dates: "auto", startWith: "last", autoSave: false, newTrip: { travelers: 1 } });
    await page.eval(`fetch("/api/saves/Padua-Milano", { method: "DELETE" })`);
  }
});

test("a booking added in the sidebar goes to the planner and onto its day; Re-plan this stay sends all its days", async () => {
  await trip(PADUA_MILANO);
  await page.eval(`document.querySelector("[data-bk-add]").click()`);
  await page.waitFor(`!!document.querySelector('.booking [data-bk="name"]')`);
  const set = (k, v) => page.eval(`(() => { const el = document.querySelector('.booking [data-bk="${k}"]'); if (el.type === "checkbox") el.checked = ${JSON.stringify(v)}; else el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await set("name", "Opera at La Scala");
  await set("date", "2027-09-17");
  await set("from", "20:00");
  await set("cost", "180");
  assert.deepEqual(await page.eval(`planner.state().bookings`), [{ name: "Opera at La Scala", date: "2027-09-17", from: "20:00", cost: 180, countCost: true }]);
  await page.eval(`window.__e2e.answer = () => ({ summary: "Plan", totalEstimatedCost: 0, days: [
    day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")]), day("2027-09-15", "Padua", [stop("10:00", "Basilica")]),
    day("2027-09-16", "Padua → Milano", [stop("17:00", "Duomo di Milano")]), day("2027-09-17", "Milano", [stop("10:00", "Castello Sforzesco")]) ] })`);
  await page.eval(`document.querySelector("#generate").click()`);
  await page.waitFor(`planner.state().itinerary?.days?.length === 4`, 20000, "the plan");
  const asked = await page.eval(`window.__e2e.requests.at(-1)`);
  assert.deepEqual(asked.bookings, [{ name: "Opera at La Scala", date: "2027-09-17", from: "20:00", cost: 180, countCost: true }], "the planner gets the booking");
  // Re-planning the Milano stay sends all its days (arrival to departure) as one change.
  await page.waitFor(`!!document.querySelector('[data-replan-stay="1"]')`, 5000, "the stay's re-plan button");
  await page.eval(`document.querySelector('[data-replan-stay="1"]').click()`);
  await answerAsk();
  await page.waitFor(`window.__e2e.requests.at(-1)?.edit?.days?.length === 2`, 10000, "the re-plan request");
  const edit = await page.eval(`window.__e2e.requests.at(-1).edit`);
  assert.deepEqual(edit.days, [2, 3]);
  assert.match(edit.request, /Re-plan these 2 days of the stay in Milano together/);
});

test("the cost breakdown shows the total, per person, by kind, per day and already-paid bookings", async () => {
  await page.eval(`planner.applyState({ ...${JSON.stringify(PADUA_MILANO)}, travelers: 2, dailyBudget: 50, currency: "EUR",
    bookings: [{ name: "Opera at La Scala", date: "2027-09-17", from: "20:00", cost: 180, countCost: false }],
    itinerary: { summary: "", totalEstimatedCost: 70, days: [
      { date: "2027-09-14", city: "Padua", title: "", estimatedCost: 30, items: [{ time: "10:00", place: "Cappella degli Scrovegni", description: "", cost: 30, kind: "sight" }] },
      { date: "2027-09-15", city: "Padua", title: "", estimatedCost: 40, items: [{ time: "12:00", place: "Lunch at Pedrocchi", description: "", cost: 40, kind: "meal" }] } ] } })`);
  await page.waitFor(`!!document.querySelector("[data-costs]")`, 10000, "the summary");
  await page.eval(`document.querySelector("[data-costs]").click()`);
  await page.waitFor(`document.querySelector("#costsDialog").open`, 5000, "the breakdown");
  const text = await page.eval(`document.querySelector("#costsBody").textContent`);
  for (const want of ["estimated total", "per person (2 travelers)", "under the budget", "already paid (not in the total)", "Sights", "Meals", "Opera at La Scala", "Most expensive"]) assert.ok(text.includes(want), want);
  assert.equal(await page.eval(`document.querySelectorAll("#costsBody .cb-day").length`), 2);
  await page.eval(`document.querySelector("#costsDialog").close()`);
});

const NO_KEYS = { anthropic: { set: false }, openai: { set: false }, openrouter: { set: false } };
const SX_NONE = { installed: false, linked: false, running: false, container: "", docker: "missing", busy: false, platform: "win32", job: null };

test("the quick start shows what's there and what's missing; without Claude Code the model menu has no Claude", async () => {
  await page.eval(`window.__e2e.setup = { claude: false, keys: ${JSON.stringify(NO_KEYS)}, ollama: { installed: true, running: true }, localModels: 0,
    search: "auto", braveKey: false, searxngUrl: "", searxng: ${JSON.stringify(SX_NONE)} }; document.querySelector("#quickstartBtn").click()`);
  await page.waitFor(`/One thing left/.test(document.querySelector(".qs-hero h2")?.textContent || "")`, 5000, "the checks");
  assert.equal(await page.eval(`document.querySelectorAll(".qs-check").length`), 5);
  assert.match(await page.eval(`document.querySelector(".qs-check:nth-child(1)").textContent`), /Claude Code.*Not found/);
  assert.match(await page.eval(`document.querySelector(".qs-check:nth-child(3)").textContent`), /Ollama.*No model yet/);
  assert.equal(await page.eval(`document.querySelectorAll("#qsKeys [data-kf]").length`), 3, "the API key inputs");
  // Choosing SearXNG shows its steps (Docker first).
  await page.eval(`document.querySelector('[data-search="searxng"]').click()`);
  await page.waitFor(`document.querySelectorAll("#qsSearxng .sx-step").length === 5`, 5000, "the SearXNG steps");
  assert.match(await page.eval(`document.querySelector("#qsSearxng .sx-step").textContent`), /Docker installed/);
  await page.eval(`fetch("/api/settings", { method: "POST", body: JSON.stringify({ tune: { search: "auto" } }) })`);
  await page.eval(`document.querySelector("#qsDone").click()`);
  // A model with no Claude Code: no Claude in the menu, and the trip switches to a model that's there.
  await page.eval(`window.__e2e.models = { claude: false, local: [{ id: "local|ollama|http://x|qwen3:8b", name: "qwen3:8b", server: "Ollama" }], cloud: [], keys: ${JSON.stringify(NO_KEYS)}, errors: {}, ollama: { installed: true, running: true } };
    document.querySelector("#refreshModels").click()`);
  await page.waitFor(`![...document.querySelectorAll("#model option")].some((o) => o.value === "opus")`, 5000, "no Claude");
  assert.equal(await page.eval(`planner.state().model`), "local|ollama|http://x|qwen3:8b");
  await page.eval(`window.__e2e.models = null; window.__e2e.setup = null; planner.state().model = "default"; document.querySelector("#refreshModels").click()`);
});

test("Your trips: cards with a route sketch, grouped coming up / past by year, filtered, searched, and as a table", async () => {
  const card = (name, start, end, extra = {}) => ({ name, savedAt: "2026-01-01T00:00:00Z", title: "", cities: ["Padua", "Milano"], start, end, nights: 4, travelers: 2, days: 0, cost: 0, currency: "EUR",
    countries: [{ cc: "it", country: "Italy" }], route: [[45.4, 11.88], [45.46, 9.19]], dots: [], bookings: 0, mustSees: 0, ...extra });
  await page.eval(`window.__e2e.trips = ${JSON.stringify([
    card("Italy 2099", "2099-05-01", "2099-05-05", { days: 5 }),
    card("Lakes 2024", "2024-06-01", "2024-06-05", { cities: ["Lucerne", "Bregenz"], countries: [{ cc: "ch", country: "Switzerland" }, { cc: "at", country: "Austria" }] }),
    card("Someday", "", "", { route: [], nights: 0 }),
  ])}; document.querySelector("#openTrips").click()`);
  await page.waitFor(`document.querySelectorAll("#tripsBody .trip-card").length === 3`, 5000, "the cards");
  assert.deepEqual(await page.eval(`[...document.querySelectorAll(".trips-group")].map((g) => g.firstChild.textContent)`), ["Coming up", "2024", "No dates yet"]);
  assert.ok(await page.eval(`!!document.querySelector('.trip-card[data-name="Italy 2099"] .pv-route')`), "the route is drawn");
  assert.match(await page.eval(`document.querySelector('.trip-card[data-name="Lakes 2024"] .tc-when').textContent`), /years? ago/);
  assert.match(await page.eval(`document.querySelector("#tripsMeta").textContent`), /3 trips · 3 countries/);
  await page.eval(`document.querySelector('[data-filter="past"]').click()`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#tripsBody .trip-card")].map((c) => c.dataset.name)`), ["Lakes 2024"]);
  await page.eval(`document.querySelector('[data-filter="all"]').click(); (() => { const s = document.querySelector("#tripsSearch"); s.value = "austria"; s.dispatchEvent(new Event("input")); })()`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll("#tripsBody .trip-card")].map((c) => c.dataset.name)`), ["Lakes 2024"], "found by country");
  await page.eval(`(() => { const s = document.querySelector("#tripsSearch"); s.value = ""; s.dispatchEvent(new Event("input")); })(); document.querySelector('[data-view="table"]').click()`);
  assert.equal(await page.eval(`document.querySelectorAll("#tripsBody .trip-row").length`), 3, "the table");
  await page.eval(`document.querySelector('[data-view="grid"]').click(); document.querySelector("#tripsDialog").close(); window.__e2e.trips = null`);
});

test("columns can be hidden and the map can fill the window; a phone shows one section at a time, with a bar of days", async () => {
  // Long enough to scroll on a phone (the bar of days shows once the days come up).
  const days = Array.from({ length: 4 }, (_, i) => ({ date: `2027-09-1${4 + i}`, city: i < 2 ? "Padua" : "Milano", title: "", estimatedCost: 0,
    items: ["Cappella degli Scrovegni", "Basilica", "Caffe Pedrocchi", "Palazzo della Ragione"].map((place, k) => ({ time: `1${k}:00`, place, description: "A while there, with a longer note about it to fill the line.", kind: "sight" })) }));
  await page.eval(`planner.applyState({ ...${JSON.stringify(PADUA_MILANO)}, itinerary: { summary: "", totalEstimatedCost: 0, days: ${JSON.stringify(days)} } })`);
  const shown = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display !== "none"`;
  await page.eval(`document.querySelector('[data-pane="settings"]').click()`);
  assert.equal(await page.eval(shown(".settings")), false, "the trip column is hidden");
  await page.eval(`document.querySelector("#mapFullBtn").click()`);
  assert.deepEqual(await page.eval(`[${shown(".settings")}, ${shown("#output")}, ${shown(".map-panel")}]`), [false, false, true], "only the map");
  await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  assert.deepEqual(await page.eval(`[${shown(".settings")}, ${shown("#output")}]`), [false, true], "back to how it was");
  await page.eval(`document.querySelector('[data-pane="settings"]').click()`);
  assert.equal(await page.eval(`document.querySelector("main").style.gridTemplateColumns`), "", "all columns: the page's own layout");
  await page.setViewport(390, 844);
  try {
    await page.waitFor(`${shown(".m-tabs")} && ${shown("#output")} && !(${shown(".settings")})`, 5000, "the phone's plan tab");
    await page.eval(`window.scrollTo(0, document.body.scrollHeight)`);
    await page.waitFor(`!document.querySelector("#mDayBar").hidden && document.querySelectorAll("#mDayBar [data-day]").length === 4`, 5000, "the bar of days");
    await page.eval(`document.querySelector('[data-tab="map"]').click()`);
    assert.deepEqual(await page.eval(`[${shown(".map-panel")}, ${shown("#output")}, document.querySelector("#mDayBar").hidden]`), [true, false, true]);
    // The chat is a tab of its own: in place of the others, with the tabs still there to leave it.
    await page.eval(`document.querySelector("[data-tab-chat]").click()`);
    await page.waitFor(`document.querySelector("[data-tab-chat]").classList.contains("on") && !(${shown(".map-panel")})`, 5000, "the chat's tab");
    assert.deepEqual(await page.eval(`[${shown(".settings")}, ${shown("#output")}, document.querySelectorAll(".m-tabs .on").length,
      document.querySelector("#chatPanel").getBoundingClientRect().bottom <= document.querySelector(".m-tabs").getBoundingClientRect().top]`), [false, false, 1, true]);
    await page.eval(`document.querySelector('[data-tab="output"]').click()`);
    await page.waitFor(`document.querySelector("#chatPanel").hidden && ${shown("#output")}`, 5000, "back from the chat");
  } finally { await page.setViewport(1500, 950); }
});

test("the chat can ask with answers to pick from; the one picked is sent as the next message", async () => {
  await page.eval(`planner.applyState({ ...${JSON.stringify(PADUA_MILANO)}, chat: [] })`);
  await page.eval(`if (document.querySelector("#chatPanel").hidden) document.querySelector("#chatBtn").click()`);
  await page.eval(`window.__e2e.companion = { answer: "To bring the transport up to date I need to know one thing.", question: { q: "How do you get around?", options: ["Public transport and the odd taxi", "By car"] } };
    (() => { const q = document.querySelector("#cpQ"); q.value = "bring my trip up to date"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  // Two answers and "Other" last, as radio rows.
  await page.waitFor(`document.querySelectorAll(".cp-ask .cp-opt input[type=radio]").length === 3`, 10000, "the question's answers");
  assert.match(await page.eval(`document.querySelector(".cp-ask").textContent`), /How do you get around\?/);
  if (process.env.E2E_SHOTS) await page.screenshot(`${process.env.E2E_SHOTS}/question.png`, ".cp-ask");
  await page.eval(`window.__e2e.companion = { answer: "Got it, by car." }; document.querySelectorAll(".cp-ask .cp-opt")[1].click()`);
  await page.waitFor(`window.__e2e.companionAsked.question === "By car"`, 10000, "the answer sent");
  await page.waitFor(`document.querySelectorAll("#cpLog .rc-msg.ai:not(.pending)").length === 2`, 10000, "the reply");
  assert.match(await page.eval(`document.querySelector(".cp-ask.done").textContent`), /By car/, "the card says what they answered");
  assert.equal(await page.eval(`document.querySelectorAll(".cp-ask .cp-opt").length`), 0, "no answers to pick any more");
  assert.match(await page.eval(`JSON.stringify(window.__e2e.companionAsked.history)`), /Asked: How do you get around\?/);
  await page.eval(`document.querySelector("#cpClose").click(); window.__e2e.companion = null`);
});

test("no errors in the page", () => {
  assert.deepEqual(page.errors, []);
});
