// Reads a web page for local models' research, like Claude's own web fetch: the page as structured text (headings,
// lists, tables), the structured data sites publish (opening hours, events, prices), long pages cut down to the parts
// about what the model is looking for, PDFs read too, and the site's own links so the model can click through instead
// of guessing addresses. Pages are kept for 15 minutes. Only public addresses, and (see `UrlGuard`) only ones that came
// up in a search or on a page already read.
import { BROWSER_UA } from "../config";
import { decodeEntities, focusText, htmlToText, pageTitle, pdfText, structuredData } from "./page-text";

/** Only public web pages: the model must not be able to reach this computer or the local network. */
export function isPublicUrl(u: string) {
  try {
    const { protocol, hostname } = new URL(u);
    return /^https?:$/.test(protocol) && hostname.includes(".")
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(hostname);
  } catch { return false; }
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const norm = (u: string) => { try { const x = new URL(u); x.hash = ""; return x.href.replace(/\/$/, ""); } catch { return u; } };

/**
 * Like Claude's web fetch, the model may only read addresses it has seen: in search results, in a page's links, or on
 * a site it's already reading (another page of the same site). A made-up address is refused with advice to search.
 */
export class UrlGuard {
  private urls = new Set<string>();
  private hosts = new Set<string>();
  /** Notes every address in a tool result (search results, a page's links). */
  saw(text: string) {
    for (const m of text.matchAll(/https?:\/\/[^\s<>"'\])]+/g)) { const u = m[0].replace(/[.,;:]+$/, ""); this.urls.add(norm(u)); this.hosts.add(host(u)); }
  }
  allowed(url: string) { return this.urls.has(norm(url)) || this.hosts.has(host(url)); }
}

/** The site's own links on a page (menu included), minus legal and boilerplate pages; the ones matching what the
 *  model looks for first. */
function siteLinks(html: string, pageUrl: string, max = 25, lookingFor = "") {
  const base = new URL(pageUrl), seen = new Set([base.href.replace(/#.*$/, "")]), out: { line: string; score: number; k: number }[] = [];
  const words = lookingFor.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL;
    try { u = new URL(decodeEntities(m[1]), base); } catch { continue; }
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 60);
    u.hash = "";
    if (u.hostname !== base.hostname || !/^https?:$/.test(u.protocol) || !text || seen.has(u.href) || /\.(jpe?g|png|gif|svg|zip|mp4|webp)$/i.test(u.pathname)) continue;
    if (/cdn-cgi|privacy|datenschutz|impressum|imprint|cookie|terms|agb|login|newsletter|javascript:/i.test(u.pathname + " " + text)) continue;
    seen.add(u.href);
    const low = `${text} ${u.pathname}`.toLowerCase();
    const score = words.filter((w) => low.includes(w)).length * 2 + (/(hours|opening|öffnungs|ticket|price|preise|visit|besuch|plan|event|kalender|calendar|timetable|fahrplan)/.test(low) ? 1 : 0);
    out.push({ line: `${text}: ${u.href}`, score, k: out.length });
  }
  return out.sort((a, b) => b.score - a.score || a.k - b.k).slice(0, max).map((x) => x.line);
}

interface Got { res: Response; html: string; pdf?: Buffer }
const cache = new Map<string, { at: number; got: Got }>();
const KEEP = 15 * 60e3;

async function getPage(url: string): Promise<Got> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < KEEP) return hit.got;
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en", Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8" }, signal: AbortSignal.timeout(20000) });
  let got: Got = { res, html: "" };
  if (res.ok) {
    const type = res.headers.get("content-type") || "";
    if (/pdf/i.test(type) || (/octet-stream/i.test(type) && /\.pdf($|\?)/i.test(url))) {
      const buf = Buffer.from(await res.arrayBuffer());
      got = { res, html: "", pdf: buf.subarray(0, 15e6) };
    } else got = { res, html: (await res.text()).slice(0, 1_500_000) };
  }
  cache.set(url, { at: Date.now(), got });
  for (const [k, v] of cache) if (Date.now() - v.at > KEEP) cache.delete(k);
  return got;
}

export interface FetchOptions {
  /** What the model wants from the page ("opening hours in September", "ticket prices"): those parts come first. */
  lookingFor?: string;
  /** Characters of page text to hand back. */
  budget?: number;
}

export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<string> {
  const { lookingFor = "", budget = 6000 } = opts;
  if (!isPublicUrl(url)) return "Only public web pages can be fetched.";
  let got: Got;
  try { got = await getPage(url); }
  catch (e: any) {
    // Say why, so the model can correct itself (e.g. a guessed domain that doesn't exist).
    const code = e.cause?.code;
    return code === "ENOTFOUND" || code === "EAI_AGAIN" ? "Fetch failed: that domain couldn't be found (it may not exist). Search for the right website first."
      : `Fetch failed: ${code || e.cause?.message || e.message}`;
  }
  const { res, html, pdf } = got;
  if (!res.ok) {
    // A guessed address: show what the site's homepage actually links to.
    const home = new URL(url).origin + "/";
    let links: string[] = [];
    if (res.status === 404 && url !== home) {
      try { const h = await getPage(home); links = h.res.ok && h.html ? siteLinks(h.html, h.res.url || home, 40, lookingFor) : []; } catch { /* homepage down too */ }
    }
    return `HTTP ${res.status}: that page doesn't exist.${links.length
      ? ` Don't guess addresses; these are the pages the homepage (${home}) links to:\n${links.join("\n")}`
      : " Search for the page instead of guessing its address."}`;
  }
  const where = res.url && res.url !== url ? ` (now at ${res.url})` : "";
  if (pdf) {
    const text = pdfText(pdf);
    return text ? `PDF${where}:\n\n${focusText(text, lookingFor, budget)}` : `This PDF${where} has no readable text (it may be scanned, or use fonts whose letters can't be read). Look for the same information on an HTML page.`;
  }
  const facts = structuredData(html);
  const text = htmlToText(html);
  const title = pageTitle(html);
  const links = siteLinks(html, res.url || url, 25, lookingFor);
  return [
    title ? `# ${title}${where}` : where.trim(),
    facts.length ? `Structured data on this page (what the site tells search engines):\n${facts.join("\n")}` : "",
    focusText(text, lookingFor, Math.max(1500, budget - facts.join("\n").length)) || "(no readable text)",
    links.length ? `Links on this page:\n${links.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
