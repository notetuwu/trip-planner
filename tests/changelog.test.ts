// The update log made from commit messages, and what opens by itself after an update.
import { describe, expect, test } from "vitest";
import { parseCommits, releases } from "../scripts/changelog.mjs";
import { canRollBack, compareVersions, onStart } from "../shared/version";

const commit = (message: string, refs = "") => `\x1e2026-11-25\x1f${refs}\x1f${message}\n`;

describe("update log", () => {
  test("groups the commits into the versions they lead to, newest first", () => {
    const log = releases(parseCommits([
      commit("First part"),
      commit("Second part; version 1.0.0\n\nMap:\n- A pin.\n\nCo-Authored-By: someone"),
      commit("Fix a thing", "tag: v1.0.1"),
      commit("Not released yet"),
    ].join("")));
    expect(log.map((r) => r.version)).toEqual(["1.0.1", "1.0.0"]);
    expect(log[1].changes.map((c) => c.subject)).toEqual(["First part", "Second part"]);
    expect(log[1].changes[1].groups).toEqual([{ head: "Map", points: ["A pin."] }]);
  });

  test("reads a message whose lines ran into the subject", () => {
    const [c] = parseCommits(commit("Split days; version 3.28.5\nTrip chat:\n- Groups."));
    expect(c).toMatchObject({ subject: "Split days", version: "3.28.5", groups: [{ head: "Trip chat", points: ["Groups."] }] });
  });
});

describe("on start", () => {
  test("compares versions by their numbers", () => {
    expect(compareVersions("3.10.0", "3.9.9")).toBeGreaterThan(0);
    expect(compareVersions("3.2.0", "3.2.0")).toBe(0);
  });

  test("rolls back only to older versions that can update themselves", () => {
    expect(canRollBack("3.28.0", "3.29.0")).toBe(true);
    expect(canRollBack("3.29.0", "3.29.0")).toBe(false);
    expect(canRollBack("3.30.0", "3.29.0")).toBe(false);
    expect(canRollBack("3.5.1", "3.29.0")).toBe(false);
  });

  test("what's new opens only after an update", () => {
    expect(onStart("3.30.0", "", false)).toBe("guide");
    expect(onStart("3.30.0", "", true)).toBe("news");
    expect(onStart("3.30.0", "3.29.0", true)).toBe("news");
    expect(onStart("3.30.0", "3.30.0", true)).toBe("nothing");
    expect(onStart("3.29.0", "3.30.0", true)).toBe("nothing");
  });
});
