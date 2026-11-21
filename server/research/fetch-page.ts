// Reads a web page as plain text for local models' research, with the site's own links so the model can click
// through instead of guessing addresses.
import { BROWSER_UA } from "../config";
import { htmlText } from "./search";

/** Only public web pages: the model must not be able to reach this computer or the local network. */
export function isPublicUrl(u: string) {
  try {
    const { protocol, hostname } = new URL(u);
    return /^https?:$/.test(protocol) && hostname.includes(".")
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(hostname);
  } catch { return false; }
}

/** The site's own links on a page (menu included), minus legal and boilerplate pages. */
function siteLinks(html: string, pageUrl: string, max = 25) {
  const base = new URL(pageUrl), seen = new Set([base.href.replace(/#.*$/, "")]), out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL;
    try { u = new URL(m[1].replace(/&amp;/g, "&"), base); } catch { continue; }
    const text = htmlText(m[2]).slice(0, 60);
    u.hash = "";
    if (u.hostname !== base.hostname || !/^https?:$/.test(u.protocol) || !text || seen.has(u.href) || /\.(jpe?g|png|gif|svg|zip|mp4)$/i.test(u.pathname)) continue;
    if (/cdn-cgi|privacy|datenschutz|impressum|imprint|cookie|terms|agb|login|newsletter/i.test(u.pathname + " " + text)) continue;
    seen.add(u.href);
    out.push(`${text}: ${u.href}`);
    if (out.length >= max) break;
  }
  return out;
}

async function getPage(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(15000) });
  return { res, html: res.ok ? (await res.text()).slice(0, 400000) : "" };
}

export async function fetchPage(url: string): Promise<string> {
  if (!isPublicUrl(url)) return "Only public web pages can be fetched.";
  let res: Response, html: string;
  try { ({ res, html } = await getPage(url)); }
  catch (e: any) {
    // Say why, so the model can correct itself (e.g. a guessed domain that doesn't exist).
    const code = e.cause?.code;
    return code === "ENOTFOUND" || code === "EAI_AGAIN" ? "Fetch failed: that domain couldn't be found (it may not exist). Search for the right website first."
      : `Fetch failed: ${code || e.cause?.message || e.message}`;
  }
  if (!res.ok) {
    // A guessed address: show what the site's homepage actually links to.
    const home = new URL(url).origin + "/";
    let links: string[] = [];
    if (res.status === 404 && url !== home) {
      try { const h = await getPage(home); links = h.res.ok ? siteLinks(h.html, h.res.url || home, 40) : []; } catch { /* homepage down too */ }
    }
    return `HTTP ${res.status}: that page doesn't exist.${links.length
      ? ` Don't guess addresses; these are the pages the homepage (${home}) links to:\n${links.join("\n")}`
      : " Search for the page instead of guessing its address."}`;
  }
  const text = htmlText(html.replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " "));
  const links = siteLinks(html, res.url || url);
  return (text.slice(0, 3500) || "(no readable text)") + (links.length ? `\n\nLinks on this page:\n${links.join("\n")}` : "");
}
