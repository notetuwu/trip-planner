// Saved places with extras in their names are also looked up by the name cut before the extras, and a result only
// counts if its name shares a real word with that.
import { describe, expect, it } from "vitest";
import { nameVariants, sameWord } from "../server/geo/geocode";

describe("the name cut before extras", () => {
  it("cuts at | ( - and produced by, keeping where it is", () => {
    expect(nameVariants("GREEN BOWL 北浜 | COFFEE & SALAD, Osaka")).toEqual(["GREEN BOWL 北浜, Osaka"]);
    expect(nameVariants("LAMP LAMP produced by SAMPLEWORKS 渋谷PARCO")).toEqual(["LAMP LAMP"]);
    expect(nameVariants("Kobe Beef Steak Sample (Main Shop), Kobe")).toEqual(["Kobe Beef Steak Sample, Kobe"]);
    expect(nameVariants("Hiroshima Castle")).toEqual([]);
  });
  it("a result counts only with a word in common", () => {
    expect(sameWord("SAMPLE TOKYO", "LAMP LAMP")).toBe(false);
    expect(sameWord("Steak Sample Kitano", "Kobe Beef Steak Sample, Kobe")).toBe(true);
    expect(sameWord("GREEN BOWL 北浜店", "GREEN BOWL 北浜, Osaka")).toBe(true);
  });
});
