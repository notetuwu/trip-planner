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

/** Removes websites that don't exist; returns how many were kept. */
export async function verifyWebsites(it: Itinerary, onStatus: (s: string) => void): Promise<number> {
  const items = it.days.flatMap((d) => d.items).filter((x) => x.website);
  for (const x of items) x.website = String(x.website).trim();
  const urls = [...new Set(items.map((x) => x.website!))];
  if (!urls.length) return 0;
  onStatus(`Checking ${urls.length} website${urls.length > 1 ? "s" : ""} the model gave…`);
  const ok = new Map(urls.map((u, i) => [u, i]));
  const results = await pool(urls, 6, pageExists);
  for (const x of items) if (!results[ok.get(x.website!)!]) delete x.website;
  return items.filter((x) => x.website).length;
}
