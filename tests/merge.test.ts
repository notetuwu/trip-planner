// Joining two people's changes to a trip against what both had last.
import { describe, expect, it } from "vitest";
import { merge3 } from "../shared/merge";

describe("merge3", () => {
  const base = { notes: "", travelers: 2, stays: [{ city: "Kyoto", nights: 3 }, { city: "Osaka", nights: 2 }], chat: [{ t: "hi" }] };

  it("takes each side's changes to different things", () => {
    const r = merge3(base, { ...base, notes: "cash" }, { ...base, travelers: 3 });
    expect(r).toEqual({ value: { ...base, notes: "cash", travelers: 3 }, clashes: [] });
  });

  it("joins lists item by item, and both sides' additions at the end", () => {
    const mine = { ...base, stays: [{ city: "Kyoto", nights: 4 }, base.stays[1]], chat: [...base.chat, { t: "a" }] };
    const theirs = { ...base, stays: [base.stays[0], { city: "Osaka", nights: 1 }], chat: [...base.chat, { t: "b" }] };
    const r = merge3(base, mine, theirs);
    expect(r.clashes).toEqual([]);
    expect(r.value).toMatchObject({ stays: [{ city: "Kyoto", nights: 4 }, { city: "Osaka", nights: 1 }], chat: [{ t: "hi" }, { t: "a" }, { t: "b" }] });
  });

  it("keeps a key one side removed, and a change both made the same", () => {
    const { notes: _n, ...without } = base;
    expect(merge3(base, without, { ...base, travelers: 3 }).value).toEqual({ ...without, travelers: 3 });
    expect(merge3(base, { ...base, notes: "x" }, { ...base, notes: "x" }).clashes).toEqual([]);
  });

  it("names what both changed differently", () => {
    expect(merge3(base, { ...base, notes: "a" }, { ...base, notes: "b" }).clashes).toEqual(["notes"]);
    const added = merge3(base, { ...base, stays: [...base.stays, { city: "Nara", nights: 1 }] }, { ...base, stays: [{ city: "Kobe", nights: 1 }] });
    expect(added.clashes).toEqual(["stays"]);
  });
});
