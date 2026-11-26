// Before rolling back to an older version, the trips and settings are copied aside.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { backUpData } from "../server/update/backup";

test("copies trips and settings, not the keys or the cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tp-backup-"));
  fs.mkdirSync(path.join(root, "saves"));
  fs.mkdirSync(path.join(root, "cache"));
  fs.writeFileSync(path.join(root, "saves", "Japan.json"), "{}");
  fs.writeFileSync(path.join(root, "settings.json"), "{}");
  fs.writeFileSync(path.join(root, "keys.json"), "{}");
  const to = backUpData(root, "before-3.28.0");
  expect(path.dirname(to)).toBe(path.join(root, "backups"));
  expect(fs.readdirSync(to).sort()).toEqual(["saves", "settings.json"]);
  expect(fs.existsSync(path.join(to, "saves", "Japan.json"))).toBe(true);
});
