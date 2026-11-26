// Updating on macOS and Linux: finding the running .app, and reading the new program out of the Linux download.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { macBundle } from "../server/update/check";
import { extractFromTarGz } from "../server/util/tar";

describe("the running macOS app", () => {
  it("is the .app around the program", () => {
    expect(macBundle("/Applications/Trip Planner.app/Contents/MacOS/trip-planner")).toBe("/Applications/Trip Planner.app");
    expect(macBundle("/Users/me/trip-planner/trip-planner")).toBeNull();
  });
});

describe("the Linux download", () => {
  it("gives the program out of the archive, as packaged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgz-"));
    try {
      const inner = path.join(dir, "trip-planner");
      fs.mkdirSync(inner);
      fs.writeFileSync(path.join(inner, "trip-planner"), "new program");
      fs.writeFileSync(path.join(inner, "README.txt"), "read me");
      const file = path.join(dir, "release.tar.gz");
      // As scripts/package.mjs makes it (the archive path relative, so Windows' tar takes it too).
      execFileSync("tar", ["-czf", "release.tar.gz", "trip-planner"], { cwd: dir });
      const got = extractFromTarGz(fs.readFileSync(file), (n) => n === "trip-planner/trip-planner");
      expect(got?.toString()).toBe("new program");
      expect(extractFromTarGz(fs.readFileSync(file), (n) => n === "trip-planner/missing")).toBeNull();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
