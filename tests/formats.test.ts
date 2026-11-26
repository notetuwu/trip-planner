// Units and formats from Settings → General.
import { beforeAll, describe, expect, it } from "vitest";

// The page's modules expect a browser; a stand-in location is enough for these.
let prefs: typeof import("../web/src/core/prefs").prefs, f: typeof import("../web/src/core/format");
beforeAll(async () => {
  (globalThis as any).location ??= { origin: "http://localhost", search: "", pathname: "/", href: "http://localhost/" };
  prefs = (await import("../web/src/core/prefs")).prefs;
  f = await import("../web/src/core/format");
});

describe("units and formats", () => {
  it("shows kilometres and 24-hour times by default", () => {
    expect([f.fmtDist(850), f.fmtDist(12500), f.fmtKm(245), f.fmtTemps(8.2, 18.4), f.fmtTime("14:30")]).toEqual(["850 m", "13 km", "245 km", "8–18 °C", "14:30"]);
  });
  it("converts to miles, °F and 12-hour times", () => {
    prefs.app = { ...prefs.app, units: "mi", temp: "f", clock: "12" };
    expect([f.fmtDist(100), f.fmtDist(5000), f.fmtKm(245), f.fmtTemps(10, 20)]).toEqual(["330 ft", "3.1 mi", "152 mi", "50–68 °F"]);
    expect([f.fmtTime("14:30"), f.fmtTime("00:05"), f.fmtTime("12:00"), f.fmtTime("9:15"), f.fmtTime("")]).toEqual(["2:30 pm", "12:05 am", "12:00 pm", "9:15 am", ""]);
    prefs.app = { ...prefs.app, units: "km", temp: "c", clock: "24" };
  });
});
