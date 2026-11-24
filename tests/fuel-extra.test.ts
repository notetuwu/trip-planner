// Fuel prices outside the EU bulletin: Switzerland's and the US's official pages are read, others come from a rough table.
import { describe, expect, it, vi } from "vitest";
import { extraFuel, parseAip, parseNrcan, parseSwiss, parseUs } from "../server/trip/fuel-extra";

describe("fuel prices outside the bulletin", () => {
  it("reads Switzerland's monthly figure", () => {
    const p = parseSwiss("… FSO · Oct 2026: petrol 2.12 CHF/L (€2.284/L), diesel 2.41 CHF/L (€2.596/L). Official …");
    expect(p).toMatchObject({ petrol: 2.284, diesel: 2.596, week: "Oct 2026", kind: "official" });
    expect(parseSwiss("nothing here")).toBeNull();
  });
  it("reads the US weekly average and converts it to euros a litre", () => {
    const t = "U.S. Regular Gasoline Prices*(dollars per gallon) full history XLS Change from 11/02/26 11/09/26 11/16/26 2 year ago year ago week ago U.S. 4.153 3.995 3.785 0.7 0.7 -0.1 East Coast"
      + " U.S. On-Highway Diesel Fuel Prices*(dollars per gallon) full history XLS Change from 11/02/26 11/09/26 11/16/26 2 year ago year ago week ago U.S. 6.292 6.127 5.937 2.4 2.0 -0.1";
    const p = parseUs(t, 1)!;
    expect(p.week).toBe("2026-11-16");
    expect(p.petrol).toBeCloseTo(3.785 / 3.78541, 2);
    expect(p.diesel).toBeCloseTo(5.937 / 3.78541, 2);
    expect(parseUs("nothing", 1)).toBeNull();
  });
  it("reads Canada's last weekly row and Australia's national petrol average", () => {
    expect(parseNrcan("Week Ending Price 2026-11-17 156.4 27.9 10 2026-11-24 150.0 27.3 9 ", 1.5)).toEqual({ eur: 1, date: "2026-11-24" });
    expect(parseNrcan("nothing", 1.5)).toBeNull();
    expect(parseAip("Week ending Sunday, 22nd November 2026 Location Weekly Average National Average 212.5 -10.5", 1.7)).toEqual({ eur: 1.25, week: "22 November 2026" });
    expect(parseAip("No data", 1.7)).toBeNull();
  });
  it("falls back to the rough table, marked approximate, and to nothing for unknown countries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await extraFuel("JP", { USD: 1.08, CAD: 1.5, AUD: 1.7 })).toMatchObject({ kind: "approx" });
    expect((await extraFuel("US", { USD: 1.08, CAD: 1.5, AUD: 1.7 }))?.kind).toBe("approx"); // the live page can't be reached
    expect(await extraFuel("ZZ", { USD: 1.08, CAD: 1.5, AUD: 1.7 })).toBeNull();
    vi.unstubAllGlobals();
  });
});
