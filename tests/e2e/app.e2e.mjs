// Browser tests of the main flows, against the built app in a headless browser (npm run build && npm run e2e).
// The server calls that need the internet or an AI model are answered inside the page (see STUBS), so the tests are
// fast and repeatable: place lookups know a few towns, routes come back as straight lines, and "the model" returns
// whatever the test sets in window.__e2e.answer.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { launch } from "./browser.mjs";

const STUBS = `(() => {
  const TOWNS = {
    padua: [45.4064, 11.8768, "it", "Italy"], milano: [45.4642, 9.19, "it", "Italy"],
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
      for (const l of body().legs || []) routes[l.mode + ":" + p5(l.from[0]) + "," + p5(l.from[1]) + ">" + p5(l.to[0]) + "," + p5(l.to[1])] = null;
      return json({ routes, pending: 0 });
    }
    if (url.includes("/api/hours")) return json((body().checks || []).map(() => ({ status: "unknown", text: "" })));
    if (url.includes("/api/open")) { window.__e2e.open.push(body().url); return json({ ok: true }); }
    if (url.includes("/api/nearby")) return json({ warming: 0 });
    if (url.includes("/api/stops")) { window.__e2e.stopsAsked = body(); return json(window.__e2e.stops); }
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

test("the theme button cycles system, light and dark", async () => {
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await page.eval(`document.querySelector("#themeBtn").click()`);
    seen.push(await page.eval(`(localStorage.getItem("trip-planner-theme") || "system") + ":" + document.documentElement.dataset.theme`));
  }
  assert.deepEqual(seen.map((s) => s.split(":")[0]), ["light", "dark", "system"]);
  assert.equal(seen[1].split(":")[1], "dark");
});

test("no errors in the page", () => {
  assert.deepEqual(page.errors, []);
});
