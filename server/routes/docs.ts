// The files kept with a trip (booking confirmations): in a "docs" folder next to it, in a sync folder the trip is in,
// or in saves/docs on this computer for a trip that isn't synced. The trip only keeps their names, so they're found on
// whoever's computer opens it.
//   GET  /api/docs?trip=<save>              where they can go
//   POST /api/docs {trip, place, files}     keeps them there: { names }
//   GET  /api/docs/file?trip=<save>&file=   one of them
import fs from "node:fs";
import path from "node:path";
import { SAVES_DIR, cleanName, errMsg } from "../config";
import * as store from "../sync/store";
import { tripDirs } from "../sync/sync";
import { type Req, type Res, readJson, sendJson } from "../util/http";

export const DOCS = "docs";
const LOCAL_PLACE = "save";
// (No .json: in a sync folder, sync would take a .json in a folder for a trip file.)
const TYPES: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  heic: "image/heic", eml: "message/rfc822", txt: "text/plain", html: "text/html", htm: "text/html",
  ics: "text/calendar", csv: "text/csv", md: "text/markdown",
};
/** Shown in the browser; everything else (an email, a web page saved from one) is downloaded, never run here. */
const SHOWN = /^(application\/pdf|image\/(jpeg|png|webp|gif))$/;
const ext = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/** A file name that's safe in every kind of folder, of a kind that's kept ("" otherwise). */
export function docName(name: unknown) {
  const clean = path.basename(String(name || "").replace(/\\/g, "/")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/^[.\s]+/, "").trim();
  const dot = clean.lastIndexOf(".");
  return dot > 0 && TYPES[ext(clean)] ? `${clean.slice(0, dot).slice(0, 100)}${clean.slice(dot)}` : "";
}

/** The name, or "name 2.pdf" and so on while it's taken. */
function free(name: string, taken: Set<string>) {
  const dot = name.lastIndexOf(".");
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${name.slice(0, dot)} ${n}${name.slice(dot)}`;
  taken.add(out.toLowerCase());
  return out;
}

const localDir = () => path.join(SAVES_DIR, DOCS);
/** The "docs" folder in a sync folder ("" when there's none and it isn't to be made). */
async function syncDocs(dir: string, make: boolean) {
  const found = (await store.listFolders(dir)).find((f) => f.name.toLowerCase() === DOCS);
  return found?.id || (make ? (await store.createFolder(dir, DOCS)).id : "");
}

/** A synced trip's files go into its sync folders (the others see them there); any other trip's stay on this computer. */
export function docPlaces(trip: string) {
  const synced = tripDirs(trip).filter((d) => d.canWrite).map((d) => ({ id: d.id, label: d.label, shared: !d.id.startsWith("local:") }));
  return synced.length ? synced : [{ id: LOCAL_PLACE, label: "This computer", shared: false }];
}

export async function keepDocs(trip: string, place: string, files: { name?: unknown; data?: unknown }[]) {
  const list = (Array.isArray(files) ? files : []).slice(0, 8).map((f) => ({ name: docName(f?.name), data: Buffer.from(String(f?.data || ""), "base64") }));
  if (!list.length || list.some((f) => !f.name || !f.data.length || f.data.length > 15_000_000)) throw new Error("These files can't be kept (pictures, PDFs, emails and text files up to 15 MB).");
  if (!docPlaces(trip).some((p) => p.id === place)) throw new Error("This trip isn't in that folder (anymore).");
  const names: string[] = [];
  if (place === LOCAL_PLACE) {
    fs.mkdirSync(localDir(), { recursive: true });
    const taken = new Set(fs.readdirSync(localDir()).map((n) => n.toLowerCase()));
    for (const f of list) { const name = free(f.name, taken); fs.writeFileSync(path.join(localDir(), name), f.data, { flag: "wx" }); names.push(name); }
  } else {
    const dir = tripDirs(trip).find((d) => d.id === place)!.dir, docs = await syncDocs(dir, true);
    const taken = new Set((await store.listDocs(docs)).map((f) => f.name.toLowerCase()));
    for (const f of list) names.push((await store.putDoc(docs, free(f.name, taken), f.data, TYPES[ext(f.name)])).name);
  }
  return { names };
}

/** One of a trip's files, from this computer or else the first of its sync folders that has it. */
export async function findDoc(trip: string, file: string): Promise<Buffer | null> {
  const name = docName(file);
  if (!name) return null;
  const here = path.join(localDir(), name);
  if (fs.existsSync(here)) return fs.readFileSync(here);
  for (const d of tripDirs(trip)) {
    const docs = await syncDocs(d.dir, false).catch(() => "");
    const found = docs ? (await store.listDocs(docs)).find((f) => f.name === name) : undefined;
    if (found) return store.getDoc(found.id);
  }
  return null;
}

export async function handleDocs(req: Req, res: Res, url: URL) {
  const trip = cleanName(url.searchParams.get("trip"));
  try {
    if (url.pathname === "/api/docs/file" && req.method === "GET") {
      const name = docName(url.searchParams.get("file")), data = await findDoc(trip, name);
      if (!data) return sendJson(res, 404, { error: "That file isn't in this trip's docs folder (anymore)." });
      const type = TYPES[ext(name)];
      res.writeHead(200, {
        "Content-Type": type, "Content-Length": String(data.length), "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `${SHOWN.test(type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return res.end(data);
    }
    if (req.method === "GET") return sendJson(res, 200, { places: docPlaces(trip) });
    if (req.method === "POST") {
      const body = await readJson(req), name = cleanName(body?.trip);
      if (!name || !fs.existsSync(path.join(SAVES_DIR, `${name}.json`))) return sendJson(res, 400, { error: "Save the trip first." });
      return sendJson(res, 200, await keepDocs(name, String(body?.place || ""), body?.files));
    }
    res.writeHead(405).end();
  } catch (e) { sendJson(res, 400, { error: errMsg(e) }); }
}
