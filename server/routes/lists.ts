// Place lists: list, read, import from Google Maps, upload a CSV, re-sync and delete.
import { cleanName } from "../config";
import { csvToPlaces } from "../lists/csv";
import { fetchGoogleList } from "../lists/google";
import { deleteList, getList, listPath, listSummaries, mergeCoords, readList, syncList, writeList } from "../lists/store";
import { type Req, type Res, readJson, sendJson } from "../util/http";

async function importGoogle(req: Req, res: Res) {
  const body = await readJson(req);
  if (!body?.url) return sendJson(res, 400, { error: "Paste a Google Maps list link." });
  const url = String(body.url).trim();
  const { title, places } = await fetchGoogleList(url);
  const listName = cleanName(body.name) || cleanName(title) || "Google list";
  const list = writeList({
    name: listName, title, source: { type: "google", url },
    places: mergeCoords(places, readList(listName)?.places), syncedAt: new Date().toISOString(),
  });
  console.log(`Imported Google Maps list "${title}" (${places.length} places) as "${listName}"`);
  return sendJson(res, 200, list);
}

export async function handleLists(req: Req, res: Res, name: string | undefined, action: string | undefined) {
  if (!name) return req.method === "GET" ? sendJson(res, 200, listSummaries()) : res.writeHead(405).end();
  if (name === "import" && req.method === "POST") return importGoogle(req, res);
  if (!listPath(name)) return sendJson(res, 400, { error: "Invalid list name" });

  if (action === "sync" && req.method === "POST") {
    const list = readList(name);
    return list ? sendJson(res, 200, await syncList(list)) : sendJson(res, 404, { error: "No such list" });
  }
  if (req.method === "GET") {
    const list = await getList(name);
    return list ? sendJson(res, 200, list) : sendJson(res, 404, { error: "No such list" });
  }
  if (req.method === "PUT") {
    const body = await readJson(req);
    // A list that came along in a trip file: its places as they are.
    if (Array.isArray(body?.places)) {
      const text = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.slice(0, n) : undefined);
      const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
      const places = body.places.filter((p: any) => text(p?.title, 300)).slice(0, 5000).map((p: any) => JSON.parse(JSON.stringify({
        title: text(p.title, 300), note: text(p.note, 2000), url: text(p.url, 1000), tags: text(p.tags, 500), comment: text(p.comment, 2000),
        address: text(p.address, 500), lat: num(p.lat), lng: num(p.lng),
      })));
      if (!places.length) return sendJson(res, 400, { error: "That list has no places." });
      const url = body.source?.type === "google" && typeof body.source.url === "string" ? body.source.url : "";
      const list = writeList({ name: cleanName(name), title: text(body.title, 200), source: url ? { type: "google", url } : { type: "upload" }, places, syncedAt: new Date().toISOString() });
      return sendJson(res, 200, list);
    }
    if (typeof body?.csv !== "string") return sendJson(res, 400, { error: "Expected { csv }" });
    const places = csvToPlaces(body.csv);
    if (!places.length) return sendJson(res, 400, { error: "No places found in that CSV (it needs a Title or Name column)." });
    const list = writeList({ name: cleanName(name), source: { type: "upload" }, places: mergeCoords(places, readList(name)?.places), syncedAt: new Date().toISOString() });
    return sendJson(res, 200, list);
  }
  if (req.method === "DELETE") {
    deleteList(name);
    return sendJson(res, 200, { ok: true });
  }
  res.writeHead(405).end();
}
