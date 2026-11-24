// Versions of saved trips and rescue copies of the trip that was open: what's kept, when, and what isn't.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RESCUE, MAX_VERSIONS, keepRescue, keepVersion, listRescue, listVersions, readRescue, readVersion, summary, versionedNames } from "../server/util/versions";

let root = "";
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "trip-saves-")); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

const trip = (extra: object = {}) => ({ stays: [{ city: "Lucerne, Switzerland" }], itinerary: { days: [{ items: [{}, {}] }, { items: [{}] }] }, ...extra });
const file = (name = "test") => path.join(root, `${name}.json`);
const write = (t: object, name = "test") => fs.writeFileSync(file(name), JSON.stringify(t));

describe("keepVersion", () => {
  it("keeps what a save held before it's overwritten, and says what's in it", () => {
    write(trip({ saveName: "test" }));
    expect(keepVersion(root, "test", file(), true)).toBe(true);
    const [v] = listVersions(root, "test");
    expect(v).toMatchObject({ cities: ["Lucerne"], days: 2, items: 3, name: "test" });
    expect(JSON.parse(readVersion(root, "test", v.id)!).stays[0].city).toBe("Lucerne, Switzerland");
    expect(versionedNames(root)).toEqual(["test"]);
  });

  it("keeps no more than one every ten minutes for saves made by themselves, but one for each made by hand", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-09-10T10:00:00Z"));
    write(trip({ n: 1 })); expect(keepVersion(root, "test", file())).toBe(true);
    vi.setSystemTime(new Date("2027-09-10T10:03:00Z"));
    write(trip({ n: 2 })); expect(keepVersion(root, "test", file())).toBe(false);
    expect(keepVersion(root, "test", file(), true)).toBe(true);
    vi.setSystemTime(new Date("2027-09-10T10:20:00Z"));
    write(trip({ n: 3 })); expect(keepVersion(root, "test", file())).toBe(true);
    expect(listVersions(root, "test").length).toBe(3);
  });

  it("keeps nothing for a save that doesn't exist yet or hasn't changed, and only the newest 40", () => {
    expect(keepVersion(root, "new", file("new"), true)).toBe(false);
    write(trip());
    expect(keepVersion(root, "test", file(), true)).toBe(true);
    expect(keepVersion(root, "test", file(), true)).toBe(false);
    vi.useFakeTimers();
    for (let i = 0; i < MAX_VERSIONS + 5; i++) {
      vi.setSystemTime(new Date(Date.UTC(2027, 8, 10, 10, i * 11)));
      write(trip({ n: i })); keepVersion(root, "test", file());
    }
    expect(listVersions(root, "test").length).toBe(MAX_VERSIONS);
  });

  it("won't hand out a version by an id that isn't a number", () => {
    write(trip()); keepVersion(root, "test", file(), true);
    expect(readVersion(root, "test", "../../test")).toBeNull();
    expect(readVersion(root, "test", "123")).toBeNull();
  });
});

describe("keepRescue", () => {
  it("keeps a copy of a trip with changes that weren't saved", () => {
    write(trip({ saveName: "test" }));
    const open = trip({ saveName: "test", marks: { Arena: "must" } });
    expect(keepRescue(root, open)).toBe(true);
    const [c] = listRescue(root);
    expect(c).toMatchObject({ name: "test", days: 2 });
    expect(JSON.parse(readRescue(root, c.id)!).marks).toEqual({ Arena: "must" });
  });

  it("keeps nothing when the trip is just what its save holds (whatever the order of its keys), or has nothing in it, or is the last copy again", () => {
    write(trip({ saveName: "test", a: 1, b: 2 }));
    expect(keepRescue(root, { b: 2, a: 1, ...trip({ saveName: "test" }) })).toBe(false);
    expect(keepRescue(root, { stays: [{ city: "" }], saveName: "" })).toBe(false);
    const open = trip({ saveName: "test", marks: { x: "must" } });
    expect(keepRescue(root, open)).toBe(true);
    expect(keepRescue(root, open)).toBe(false);
    expect(listRescue(root).length).toBe(1);
  });

  it("keeps a trip that was never saved, and only the newest copies", () => {
    expect(keepRescue(root, trip())).toBe(true);
    vi.useFakeTimers();
    for (let i = 0; i < MAX_RESCUE + 3; i++) { vi.setSystemTime(new Date(Date.UTC(2027, 8, 10, 10, i))); keepRescue(root, trip({ n: i })); }
    expect(listRescue(root).length).toBe(MAX_RESCUE);
  });
});

describe("summary", () => {
  it("copes with text that isn't a trip", () => {
    expect(summary("not json")).toEqual({ cities: [], days: 0, items: 0, chat: 0, name: "" });
  });
});
