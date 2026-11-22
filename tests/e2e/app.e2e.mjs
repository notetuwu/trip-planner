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
    osaka: [34.6937, 135.5023, "jp", "Japan"], kyoto: [35.0116, 135.7681, "jp", "Japan"],
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
  assert.deepEqual(await page.eval(`[planner.state().marks.Lugano, planner.state().how.Lugano]`), ["must", "way"], "a stop on the way becomes a must-see on the way");
  await page.eval(`document.querySelector("#toast button").click()`);
  assert.deepEqual(await page.eval(`planner.state().stays.map((s) => s.city)`), ["Padua"], "Undo restores the stays");
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
  await page.eval(`window.prompt = () => ""; document.querySelector('[data-redo="1"]').click()`);
  await page.waitFor(`!!document.querySelector("#day-1 .inline-progress")`);
  assert.equal(await page.eval(`document.querySelectorAll("#day-0 .item").length`), 1, "the other day stays visible");
  assert.equal(await page.eval(`!!document.querySelector("#output > .empty.loading")`), false, "no full-page progress");
  await page.waitFor(`[...document.querySelectorAll("#day-1 .item .name")].map((e) => e.textContent.trim()).join() === "Orto Botanico"`);
  assert.match(await page.eval(`document.querySelector("#toast").textContent`), /re-planned/);
  assert.equal(await page.eval(`window.__e2e.requests[0].redoDay.day`), 1);
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

test("links in the app's own window go to the default browser", async () => {
  await page.eval(`sessionStorage.setItem("trip-planner-app-window", "1"); location.reload()`);
  await page.waitFor("document.readyState === 'complete' && !!window.planner");
  await trip(PADUA_MILANO);
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [day("2027-09-14", "Padua", [stop("15:00", "Cappella degli Scrovegni")])] } })`);
  await page.eval(`document.querySelector(".item .name a").click()`);
  await page.waitFor(`window.__e2e.open.length === 1`);
  assert.match(await page.eval(`window.__e2e.open[0]`), /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Cappella/);
});

test("book ahead links hotels and transport; the packing list fits the countries", async () => {
  await trip({
    stays: [{ city: "Osaka", start: "2027-04-01", nights: 3, hotel: "around the Garden Court Hotel" }, { city: "Kyoto", start: "2027-04-04", nights: 2, hotel: "", travel: "train" }],
    list: "", listChosen: true, travelers: 2, autoFix: false,
  });
  await page.eval(`planner.applyState({ ...planner.state(), itinerary: { summary: "", totalEstimatedCost: 0, days: [
    day("2027-04-01", "Osaka", [stop("15:00", "Osaka Castle")]), day("2027-04-02", "Osaka", [stop("10:00", "Onsen Spa World")]) ] } })`);
  await page.waitFor(`!!document.querySelector('details[data-fold="book-ahead"]')`);
  const links = await page.eval(`[...document.querySelectorAll('.book-ahead li.trip a')].map((a) => a.href)`);
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
  const packing = await page.eval(`document.querySelector('details[data-fold="packing"]').textContent`);
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
  const chat = Array.from({ length: 18 }, (_, k) => ({ role: k % 2 ? "ai" : "me", text: `message ${k}` }));
  await trip({ stays: [{ city: "Padua", start: "2027-09-14", nights: 2, hotel: "" }], list: "", listChosen: true, autoFix: false, chat });
  await page.eval(`window.__e2e.companion = { answer: "Noted." }; document.querySelector("#chatBtn").click();
    (() => { const q = document.querySelector("#cpQ"); q.value = "one more"; q.dispatchEvent(new Event("input")); document.querySelector("#cpSend").click(); })()`);
  await page.waitFor(`planner.state().chat.length === 20`, 10000, "the answer");
  const asked = await page.eval(`window.__e2e.compactAsked`);
  assert.equal(asked.turns.length, 12, "the 18 messages minus the 6 most recent");
  assert.equal(await page.eval(`planner.state().chatSummarized`), 12);
  const sent = await page.eval(`window.__e2e.companionAsked`);
  assert.equal(sent.summary, "- They want Pedrocchi on the way.");
  assert.equal(sent.history[0].text, "message 12", "only what came after the summary");
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
  await page.eval(`window.confirm = () => true; planner.importTrip(new File([${JSON.stringify(file.text)}], "shared.trip.json"))`);
  await page.waitFor(`planner.state().stays[0].city === "Padua"`, 10000, "the imported trip");
  assert.equal(await page.eval(`document.querySelector("#ideas").value`), "Brenta boat");
  assert.equal(await page.eval(`planner.state().marks["Caffe Pedrocchi"]`), "must");
  await page.waitFor(`document.querySelector("#saveList").value === "shared"`, 5000, "the import in the saved trips");
  // Importing the same file again keeps the first copy and saves a second one.
  await page.eval(`planner.importTrip(new File([${JSON.stringify(file.text)}], "shared.trip.json"))`);
  await page.waitFor(`document.querySelector("#saveList").value === "shared 2"`, 5000, "a second copy, not an overwrite");
  await page.eval(`planner.importTrip(new File(["not json"], "bad.json"))`);
  await page.waitFor(`/isn't a trip file/.test(document.querySelector("#saveStatus").textContent)`, 5000, "the error");
  assert.equal(await page.eval(`planner.state().stays[0].city`), "Padua", "a bad file changes nothing");
});

test("an imported trip brings its place lists along", async () => {
  const file = { format: "trip-planner-trip", trip: { ...PADUA_MILANO, lists: ["Shared ideas"], list: "Shared ideas" },
    lists: [{ name: "Shared ideas", title: "Shared ideas", places: [{ title: "Orto Botanico di Padova", lat: 45.3994, lng: 11.8807 }] }] };
  await page.eval(`window.confirm = () => true; planner.importTrip(new File([${JSON.stringify(JSON.stringify(file))}], "with-list.trip.json"))`);
  await page.waitFor(`(planner.state().lists || []).includes("Shared ideas")`, 10000, "the list ticked");
  const list = await page.eval(`fetch("/api/lists/Shared%20ideas").then((r) => r.json())`);
  assert.equal(list.places[0].title, "Orto Botanico di Padova");
  await page.eval(`fetch("/api/lists/Shared%20ideas", { method: "DELETE" })`);
});

test("no errors in the page", () => {
  assert.deepEqual(page.errors, []);
});
