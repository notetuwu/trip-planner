// Web search for local models' research, trying backends in order. Brave and SearXNG need setting up but are
// reliable; DuckDuckGo needs nothing but shows a bot check after many quick searches; Wikivoyage/Wikipedia always
// work but only know articles.
import { BROWSER_UA, USER_AGENT, errMsg, sleep } from "../config";

interface SearchResult { title: string; url: string; snippet: string }
interface Backend { name: string; enabled(): boolean; search(q: string): Promise<SearchResult[]> }

export const htmlText = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#x27;|&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

let ddgLast = 0, ddgBlockedUntil = 0;

const brave: Backend = {
  name: "Brave Search", enabled: () => !!process.env.BRAVE_API_KEY,
  async search(q) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: "6" })}`, {
      headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY!, Accept: "application/json" }, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (((await res.json()) as any).web?.results || []).map((r: any) => ({ title: htmlText(r.title || ""), url: r.url, snippet: htmlText(r.description || "") }));
  },
};

const searxng: Backend = {
  name: "SearXNG", enabled: () => !!process.env.SEARXNG_URL,
  async search(q) {
    const base = process.env.SEARXNG_URL!.replace(/\/+$/, "");
    const res = await fetch(`${base}/search?${new URLSearchParams({ q, format: "json" })}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (((await res.json()) as any).results || []).slice(0, 6).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content || "" }));
  },
};

const duckduckgo: Backend = {
  name: "DuckDuckGo", enabled: () => Date.now() > ddgBlockedUntil,
  async search(q) {
    // Space searches out; rapid-fire queries trigger the bot check sooner.
    const wait = ddgLast + 2500 - Date.now();
    if (wait > 0) await sleep(wait);
    ddgLast = Date.now();
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST", body: new URLSearchParams({ q }), signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const html = await res.text();
    if (res.status === 202 || /anomaly-modal|challenge-form/.test(html)) {
      ddgBlockedUntil = Date.now() + 15 * 60e3;
      console.log("DuckDuckGo is showing its bot check; skipping it for 15 minutes.");
      throw new Error("bot check");
    }
    const results: SearchResult[] = [];
    const re = /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    for (let m; (m = re.exec(html)) && results.length < 6;) {
      let url = m[1].replace(/&amp;/g, "&");
      const redirect = url.match(/[?&]uddg=([^&]+)/); // DuckDuckGo sometimes wraps links in a redirect
      if (redirect) url = decodeURIComponent(redirect[1]);
      if (url.startsWith("//")) url = "https:" + url;
      results.push({ title: htmlText(m[2]), url, snippet: htmlText(m[3]) });
    }
    return results;
  },
};

const wikis: Backend = {
  name: "Wikivoyage + Wikipedia", enabled: () => true,
  async search(q) {
    // Wiki search matches article text, so drop words like "opening hours 2026" that articles rarely contain.
    const simple = q.replace(/\b(opening|hours|times?|tickets?|prices?|cost|202\d|official|website|how to get|from|to)\b/gi, " ").replace(/\s+/g, " ").trim() || q;
    const wiki = async (site: string) => {
      const res = await fetch(`https://${site}/w/api.php?${new URLSearchParams({ action: "query", list: "search", srsearch: simple, format: "json", srlimit: "3" })}`, {
        headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000),
      });
      return (((await res.json()) as any).query?.search || []).map((r: any) => ({
        title: `${r.title} (${site.split(".")[1]})`, url: `https://${site}/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`, snippet: htmlText(r.snippet || ""),
      }));
    };
    const [voy, wp] = await Promise.all([wiki("en.wikivoyage.org"), wiki("en.wikipedia.org")]);
    return [...voy, ...wp];
  },
};

const BACKENDS = [brave, searxng, duckduckgo, wikis];

/** The result text handed to the model. */
export async function webSearch(query: string): Promise<string> {
  const failed: string[] = [];
  for (const b of BACKENDS.filter((b) => b.enabled())) {
    try {
      const results = await b.search(query);
      if (!results.length) { failed.push(`${b.name}: no results`); continue; }
      const note = b === wikis
        ? "(Web search is unavailable right now; these are Wikivoyage/Wikipedia results. You can still read official websites with fetch_page.)\n\n" : "";
      return note + results.map((x) => `${x.title}\n${x.url}\n${x.snippet}`).join("\n\n");
    } catch (e) { failed.push(`${b.name}: ${errMsg(e)}`); }
  }
  return `No results (${failed.join("; ")}). Try a shorter query, or read a known official website with fetch_page.`;
}
