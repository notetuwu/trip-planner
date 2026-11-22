// Web research for local models: they can't browse, so the planner runs their web_search / fetch_page tool calls
// and hands back the results. The findings go into the planning prompt.
import type { Place } from "../../shared/types";
import { serverName } from "../ai/local-models";
import { tripLine } from "../ai/prompt-sections";
import type { OnEvent, Trip } from "../ai/types";
import { addDays } from "../config";
import { MAX_LOOKUPS, RESEARCH_CTX, type RoundContext, type ToolCall, chatRound } from "./chat-round";
import { tune } from "../settings";
import { UrlGuard, fetchPage } from "./fetch-page";
import { webSearch } from "./search";

/** Addresses the model may open without having seen them (official sites it knows), per research round. */
const KNOWN_FETCHES = 6;

/** The words of a search query, for spotting the same search again in other words. */
const queryWords = (q: string) => new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
/** Mostly the same words ("Pokemon Center Osaka DX hours" / "… official opening hours"). */
function sameSearch(a: Set<string>, b: Set<string>) {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both) >= 0.7;
}
/** A page that couldn't be read (gone, refused, unreachable): it costs no lookup and isn't a source. */
const unread = (page: string) => /^(Fetch failed|HTTP \d|Only public)/.test(page);

/** Re-planning one day needs only a few lookups about that day. */
const DAY_LOOKUPS = 8;
const lookupLimit = (trip: Trip) => { const most = Math.min(tune().lookups, MAX_LOOKUPS); return trip.redoDay ? Math.min(DAY_LOOKUPS, most) : most; };

function dayResearchPrompt(trip: Trip, limit: number) {
  const { itinerary, day, request } = trip.redoDay!;
  const d = itinerary.days[day];
  // The stay whose dates include the day (on a travel day, the one you arrive at).
  const stay = trip.stays.filter((s) => s.start && d.date >= s.start && d.date <= addDays(s.start, Number(s.nights) || 0)).at(-1);
  return `You are researching one day of a trip before it gets re-planned: ${d.date} in ${d.city}${stay ? ` (staying in ${stay.city})` : ""}.
${request ? `The travelers ask: ${request}\n` : ""}Currently planned that day: ${d.items.map((x) => x.place).join("; ") || "nothing"}.
Travelers: ${trip.travelers}. Interests: ${trip.interests || "none given"}.

Look up only what this day needs: opening hours and closing days on ${d.date} of places they might visit that day, events that day in ${d.city}, and getting around. Don't research other days or cities.
You can make up to ${limit} tool calls. Prefer official websites. Short search queries work best. Prefer URLs from search results (including their "Official website" lines) or from the "Links on this page" list of a page you read; a few official sites you know for sure are fine too. Say what you're after with looking_for. When you are done, reply with a concise summary of your findings as "- " bullet points, each ending with its source URL in brackets. Don't plan the day itself, and don't ask questions or offer to do more: nobody can answer.`;
}

function researchPrompt(trip: Trip, places: Place[]) {
  if (trip.redoDay) return dayResearchPrompt(trip, lookupLimit(trip));
  const must = places.filter((p) => trip.mustSee?.includes(p.title)).map((p) => p.title);
  return `You are researching a trip before it gets planned. Use the web_search and fetch_page tools to find facts that matter for these dates:
- opening hours and closing days of the must-see places on the trip dates, and current ticket prices
- festivals, events and public holidays in these places during the trip
- how to get between the cities (train/bus options, travel times, prices)
- anything else date-dependent for the travelers' interests

Trip: ${tripLine(trip)}.
Travelers: ${trip.travelers}. Interests: ${trip.interests || "none given"}. Notes: ${trip.notes || "none"}.
${must.length ? `Must-see places: ${must.join(", ")}.` : ""}

You can make up to ${lookupLimit(trip)} tool calls, so be thorough: when you come across places or events worth including, look those up too. Prefer official websites, and read the most useful pages with fetch_page instead of relying on snippets; say what you're after with looking_for (e.g. "opening hours in September"), so long pages come back cut to those parts. Short search queries work best. Prefer URLs from search results (including their "Official website" lines) or from the "Links on this page" list of a page you read (follow those links to reach opening-hours or ticket pages); a few official sites you know for sure are fine too. PDFs (timetables, price lists) can be read too. Don't repeat a search in other words: if one finds nothing useful, read a page instead. When you are done, reply with a concise summary of your findings as "- " bullet points, each ending with its source URL in brackets; also list briefly what you couldn't find out. Don't plan the itinerary itself, and don't ask questions or offer to do more: nobody can answer.`;
}

/** prompt: what to research instead of the usual (step-by-step planning asks about its outlined days). */
interface ResearchOptions extends Omit<RoundContext, "messages"> { trip: Trip; places: Place[]; onEvent: OnEvent; prompt?: string }

/** Runs the research conversation; returns its findings and the pages read. Throws "NO_TOOLS" if the model can't use tools. */
export async function localResearch(o: ResearchOptions): Promise<{ notes: string; urls: string[] }> {
  const { kind, base, model, onEvent } = o;
  const limit = lookupLimit(o.trip);
  const messages: any[] = [{ role: "user", content: o.prompt || researchPrompt(o.trip, o.places) }];
  onEvent({
    type: "prompt", label: "Research prompt",
    info: `Sent to ${serverName(kind, base)} · model: ${model} · tools: web_search, fetch_page (run by the planner) · temperature 0.3`
      + `${kind === "ollama" ? ` · context ${RESEARCH_CTX.toLocaleString()} tokens` : ""} · up to ${limit} lookups. ${kind === "ollama" ? "Ollama adds the model's own system prompt, if it has one." : ""}`,
    text: messages[0].content,
  });
  const urls: string[] = [];
  let lookups = 0;
  // Addresses the model has seen (search results, links on pages it read, the travelers' own places): only those, or
  // other pages of those sites, get fetched.
  const guard = new UrlGuard();
  let known = 0, tries = 0, searchDown = false;
  const searches: { words: Set<string>; text: string }[] = [];
  const pages = tune().pages;
  for (const p of o.places) if (p.url) guard.saw(p.url);
  onEvent({ type: "status", text: o.trip.redoDay ? "Researching this day online…" : "Researching online…" });

  const runTool = async (c: ToolCall) => {
    // Searches that find nothing and pages that can't be read don't count as lookups, but tries are capped too.
    if (lookups >= limit || tries >= limit * 2) return "Lookup limit reached; summarize what you have.";
    tries++;
    if (c.name === "web_search" && c.args.query) {
      const words = queryWords(c.args.query);
      const same = searches.find((s) => sameSearch(words, s.words));
      if (same) return `You already searched for "${same.text}" (results above). Search for something different, or read one of the pages found with fetch_page.`;
      searches.push({ words, text: c.args.query });
      onEvent({ type: "search", query: c.args.query });
      const found = await webSearch(c.args.query).catch((e) => `Search failed: ${e.message}`);
      const empty = /^(No results \(|Search failed)/.test(found);
      if (!empty) lookups++;
      guard.saw(found);
      // Web search not working on this connection (only the wikis answer): say once that reading sites works better,
      // and let it open more official sites it knows.
      if (!searchDown && (empty || found.startsWith("(Web search is unavailable"))) {
        searchDown = true;
        return `${found}\n\nNote: web search isn't working well right now, so more searches won't help much. Read the official websites you know directly with fetch_page (you can open up to ${KNOWN_FETCHES * 3} addresses that haven't come up in a search), and follow their links.`;
      }
      return found;
    }
    if (c.name === "fetch_page" && c.args.url) {
      // A made-up address costs no lookup, but isn't fetched.
      // Settings → Planning: any public page; or found ones plus a few it knows itself (an official site it remembers);
      // or only found ones (in search results, or linked from a page it read).
      if (pages !== "any" && !guard.allowed(c.args.url)) {
        if (pages === "found" || known >= (searchDown ? KNOWN_FETCHES * 3 : KNOWN_FETCHES)) return "That address hasn't come up in a search or on a page you read, so it wasn't fetched. Search for the page first, or follow a link from a page you've read.";
        known++;
      }
      onEvent({ type: "fetch", url: c.args.url });
      const page = await fetchPage(c.args.url, { lookingFor: c.args.looking_for || "" }).catch((e) => `Fetch failed: ${e.message}`);
      if (!unread(page)) { lookups++; urls.push(c.args.url); }
      guard.saw(page);
      return page;
    }
    return "Unknown tool or missing argument.";
  };

  const maxRounds = limit + 2;
  for (let round = 0; round < maxRounds; round++) {
    // The last round has no tools, so the model has to write its summary.
    const allowTools = lookups < limit && round < maxRounds - 1;
    let reply;
    try { reply = await chatRound({ ...o, messages }, allowTools); }
    catch (e) {
      if ((e as Error).message !== "LOOP") throw e;
      // Stuck repeating itself: ask once more, without thinking or tools, for a summary of what it found so far.
      onEvent({ type: "status", text: "The model got stuck repeating itself; asking it to sum up what it found…" });
      messages.push({ role: "user", content: "Stop researching now. Summarize what you found so far as \"- \" bullet points with their source URLs." });
      try { reply = await chatRound({ ...o, messages }, false, true); } catch { return { notes: "", urls }; }
    }
    const { content, calls } = reply;
    if (!calls.length) return { notes: content.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), urls };
    for (const c of calls) {
      const result = await runTool(c);
      onEvent({ type: "prompt", label: `Result of ${c.name}(${c.args.query || c.args.url || ""}${c.args.looking_for ? `, looking for: ${c.args.looking_for}` : ""})`, text: result });
      messages.push(kind === "ollama" ? { role: "tool", tool_name: c.name, content: result } : { role: "tool", tool_call_id: c.id, content: result });
    }
  }
  return { notes: "", urls };
}
