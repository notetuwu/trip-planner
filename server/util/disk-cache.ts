// A JSON object kept in memory and written to cache/<name>.json a moment after it changes.
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../config";

export interface DiskCache<T> {
  data: Record<string, T>;
  /** Write soon (debounced), so bursts of updates cost one write. */
  save(): void;
  /** Write right away. */
  saveNow(): void;
}

export function diskCache<T>(name: string): DiskCache<T> {
  const file = path.join(CACHE_DIR, name);
  let data: Record<string, T> = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }
  let timer: NodeJS.Timeout | undefined;
  const saveNow = () => {
    clearTimeout(timer);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache.data));
  };
  const cache: DiskCache<T> = {
    data,
    save() { clearTimeout(timer); timer = setTimeout(saveNow, 2000); },
    saveNow,
  };
  return cache;
}
