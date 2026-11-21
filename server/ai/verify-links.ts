// Models (local ones especially) sometimes invent websites. Before a plan is shown, every website it gives is
// fetched once; addresses that don't exist (no such domain, 404, timeouts) are dropped.
import type { Itinerary } from "../../shared/types";
import { BROWSER_UA } from "../config";
import { pool } from "../trip/overpass";

/** Does the page exist? Sites that block robots (401/403/429) still count; missing pages and dead domains don't. */
export async function pageExists(url: string): Promise<boolean> {
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/.test(url)) return false;
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(8000) });
    res.body?.cancel().catch(() => {});
    return res.status < 400 || [401, 403, 405, 429].includes(res.status);
  } catch { return false; }
}

const URL_IN_TEXT = /https?:\/\/[^\s)\]<>"]+[^\s)\]<>".,;:!?]/g;

/** Removes websites that don't exist, from the stops and from the tips; returns how many stop websites were kept. */
export async function verifyWebsites(it: Itinerary, onStatus: (s: string) => void): Promise<number> {
  const items = it.days.flatMap((d) => d.items).filter((x) => x.website);
  for (const x of items) x.website = String(x.website).trim();
  const tipUrls = (it.tips || []).flatMap((t) => t.match(URL_IN_TEXT) || []);
  const urls = [...new Set([...items.map((x) => x.website!), ...tipUrls])];
  if (!urls.length) return 0;
  onStatus(`Checking ${urls.length} website${urls.length > 1 ? "s" : ""} the model gave…`);
  const results = await pool(urls, 6, pageExists);
  const ok = new Set(urls.filter((_, i) => results[i]));
  for (const x of items) if (!ok.has(x.website!)) delete x.website;
  // A dead link in a tip goes, with the "(…)" or "at …" around it when that's all that's left.
  if (it.tips) it.tips = it.tips.map((t) => t.replace(URL_IN_TEXT, (u) => ok.has(u) ? u : "\u0000")
    .replace(/\s*(\((see|at|via|buy at|from)?\s*\u0000\s*\)|(at|via|from|on|see)\s+\u0000|\u0000)/gi, "").replace(/\s+([.,;])/g, "$1").trim());
  return items.filter((x) => x.website).length;
}
