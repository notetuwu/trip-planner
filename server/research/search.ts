// Web search for local models' research, trying backends in order. Brave and SearXNG need setting up but are
// reliable; DuckDuckGo needs nothing but shows a bot check after many quick searches; Wikivoyage/Wikipedia always
// work but only know articles.
import { BROWSER_UA, USER_AGENT, errMsg, sleep } from "../config";
import { readSettings } from "../settings";
import { SEARXNG_LOCAL, ensureSearxng } from "../routes/searxng";

/** The Brave key and SearXNG address: from Settings → Planning, or the environment variables. */
const braveKey = () => readSettings().braveKey || process.env.BRAVE_API_KEY || "";
const searxngUrl = () => readSettings().searxngUrl || process.env.SEARXNG_URL || "";

interface SearchResult { title: string; url: string; snippet: string; official?: string }
interface Backend { name: string; enabled(): boolean; search(q: string): Promise<SearchResult[]> }

export const htmlText = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#x27;|&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

let ddgLast = 0, ddgBlockedUntil = 0;

const brave: Backend = {
  name: "Brave Search", enabled: () => !!braveKey(),
  async search(q) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: "6" })}`, {
      headers: { "X-Subscription-Token": braveKey(), Accept: "application/json" }, signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (((await res.json()) as any).web?.results || []).map((r: any) => ({ title: htmlText(r.title || ""), url: r.url, snippet: htmlText(r.description || "") }));
  },
};

const searxng: Backend = {
  name: "SearXNG", enabled: () => !!searxngUrl(),
  async search(q) {
    const base = searxngUrl().replace(/\/+$/, "");
    const get = () => fetch(`${base}/search?${new URLSearchParams({ q, format: "json" })}`, { signal: AbortSignal.timeout(15000) });
    // The one set up from Settings isn't running (Docker closed, after a restart): start it, then try again.
    let res = await get().catch(async (e) => { if (base === SEARXNG_LOCAL && (await ensureSearxng())) return get(); throw e; });
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
    // Wikipedia knows many places' official websites (through Wikidata): give those too, so the model can read them.
    const sites = await officialSites(wp.map((r: SearchResult) => decodeURIComponent(r.url.split("/wiki/")[1] || "").replace(/_/g, " "))).catch(() => new Map<string, string>());
    for (const r of wp) {
      const site = sites.get(decodeURIComponent(r.url.split("/wiki/")[1] || "").replace(/_/g, " "));
      if (site) r.official = site;
    }
    return [...voy, ...wp];
  },
};

/** The official website (Wikidata P856) of Wikipedia articles, by title. Two small requests for all of them. */
async function officialSites(titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!titles.length) return out;
  const pp = await fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: "query", prop: "pageprops", ppprop: "wikibase_item", titles: titles.join("|"), format: "json", redirects: "1" })}`, {
    headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000),
  }).then((r) => r.json()) as any;
  // Titles as asked (before redirects) to their Wikidata items.
  const back = new Map<string, string>();
  for (const r of pp.query?.redirects || []) back.set(r.to, r.from);
  for (const n of pp.query?.normalized || []) back.set(n.to, n.from);
  const items = new Map<string, string>();
  for (const page of Object.values(pp.query?.pages || {}) as any[]) {
    const q = page.pageprops?.wikibase_item;
    if (q) items.set(q, back.get(page.title) || page.title);
  }
  if (!items.size) return out;
  const wd = await fetch(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: "wbgetentities", ids: [...items.keys()].join("|"), props: "claims", format: "json" })}`, {
    headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000),
  }).then((r) => r.json()) as any;
  for (const [id, e] of Object.entries(wd.entities || {}) as [string, any][]) {
    const url = e.claims?.P856?.find((c: any) => c.rank !== "deprecated")?.mainsnak?.datavalue?.value;
    if (typeof url === "string" && /^https?:\/\//.test(url)) out.set(items.get(id)!, url);
  }
  return out;
}

const BACKENDS = [brave, searxng, duckduckgo, wikis];

/** The engines to try, in order: the one chosen in Settings → Planning first (then Wikipedia if it fails), or all. */
function backends() {
  const choice = readSettings().tune.search;
  if (choice === "brave" && brave.enabled()) return [brave, wikis];
  if (choice === "searxng" && searxng.enabled()) return [searxng, wikis];
  return BACKENDS;
}

/** The result text handed to the model. */
export async function webSearch(query: string): Promise<string> {
  const failed: string[] = [];
  for (const b of backends().filter((b) => b.enabled())) {
    try {
      const results = await b.search(query);
      if (!results.length) { failed.push(`${b.name}: no results`); continue; }
      const note = b === wikis
        ? "(Web search is unavailable right now; these are Wikivoyage/Wikipedia results. You can still read official websites with fetch_page.)\n\n" : "";
      return note + results.map((x) => `${x.title}\n${x.url}\n${x.snippet}${x.official ? `\nOfficial website: ${x.official}` : ""}`).join("\n\n");
    } catch (e) { failed.push(`${b.name}: ${errMsg(e)}`); }
  }
  return `No results (${failed.join("; ")}). Try a shorter query, or read a known official website with fetch_page.`;
}
