// Place lists, stored as lists/<name>.json. CSV files in the project folder become lists automatically.
import fs from "node:fs";
import path from "node:path";
import type { ListSummary, Place, PlaceList } from "../../shared/types";
import { LISTS_DIR, ROOT, cleanName } from "../config";
import { csvToPlaces } from "./csv";
import { fetchGoogleList } from "./google";

export const listPath = (name: string) => { const n = cleanName(name); return n ? path.join(LISTS_DIR, n + ".json") : null; };

export function readList(name: string): PlaceList | null {
  const f = listPath(name);
  return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

export function writeList(list: PlaceList): PlaceList {
  fs.mkdirSync(LISTS_DIR, { recursive: true });
  fs.writeFileSync(listPath(list.name)!, JSON.stringify(list, null, 1));
  return list;
}

export function deleteList(name: string) {
  const f = listPath(name);
  if (f && fs.existsSync(f)) fs.unlinkSync(f);
}

/** Keep coordinates we already had when a re-import comes back without them. */
export function mergeCoords(fresh: Place[], old: Place[] = []): Place[] {
  const byTitle = new Map(old.map((p) => [p.title, p]));
  return fresh.map((p) => {
    const o = byTitle.get(p.title);
    return p.lat == null && o?.lat != null ? { ...p, lat: o.lat, lng: o.lng } : p;
  });
}

/** Re-imports a list from its source (Google Maps or a CSV file). */
export async function syncList(list: PlaceList): Promise<PlaceList> {
  const src = list.source;
  if (src?.type === "google") {
    const { title, places } = await fetchGoogleList(src.url);
    list.places = mergeCoords(places, list.places);
    list.title = title || list.title;
  } else if (src?.type === "csv" && fs.existsSync(src.file)) {
    list.places = mergeCoords(csvToPlaces(fs.readFileSync(src.file, "utf8")), list.places);
  } else return list;
  list.syncedAt = new Date().toISOString();
  return writeList(list);
}

/** CSV files next to the app (e.g. a Google Takeout export) show up as lists and re-sync when edited. */
export function adoptCsvFiles() {
  const files = fs.readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => path.join(ROOT, f));
  if (process.env.PLACES_CSV) files.push(path.resolve(process.env.PLACES_CSV));
  for (const file of files) {
    const name = cleanName(path.basename(file, path.extname(file)));
    if (!name || !fs.existsSync(file) || readList(name)) continue;
    writeList({ name, source: { type: "csv", file }, places: csvToPlaces(fs.readFileSync(file, "utf8")), syncedAt: new Date().toISOString() });
    console.log(`Imported ${path.basename(file)} as place list "${name}"`);
  }
}

export function listSummaries(): ListSummary[] {
  if (!fs.existsSync(LISTS_DIR)) return [];
  return fs.readdirSync(LISTS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
    const l: PlaceList = JSON.parse(fs.readFileSync(path.join(LISTS_DIR, f), "utf8"));
    return { name: l.name, title: l.title || "", count: l.places.length, source: l.source, syncedAt: l.syncedAt };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** A list, re-read from its CSV file first if that changed since the last sync. */
export async function getList(name: string): Promise<PlaceList | null> {
  const list = readList(name);
  const src = list?.source;
  if (list && src?.type === "csv" && fs.existsSync(src.file) && fs.statSync(src.file).mtime > new Date(list.syncedAt || 0)) {
    return syncList(list);
  }
  return list;
}
