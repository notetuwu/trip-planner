// A copy of what the user made (trips, place lists, settings), kept before going back to an older version.
import fs from "node:fs";
import path from "node:path";

const KEPT = ["saves", "lists", "settings.json", "current-trip.json"];

/** Copies the data in `root` to a new folder under its "backups" folder and returns that folder. Throws when it can't. */
export function backUpData(root: string, name: string) {
  const to = path.join(root, "backups", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(to, { recursive: true });
  for (const f of KEPT) {
    const from = path.join(root, f);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(to, f), { recursive: true });
  }
  return to;
}
