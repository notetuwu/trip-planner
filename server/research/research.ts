// Web research for local models: they can't browse, so the planner runs their web_search / fetch_page tool calls
// and hands back the results. The findings go into the planning prompt.
import type { Place } from "../../shared/types";
import { serverName } from "../ai/local-models";
import { tripLine } from "../ai/prompt-sections";
import type { OnEvent, Trip } from "../ai/types";
import { MAX_LOOKUPS, RESEARCH_CTX, type RoundContext, type ToolCall, chatRound } from "./chat-round";
import { fetchPage } from "./fetch-page";
import { webSearch } from "./search";

function researchPrompt(trip: Trip, places: Place[]) {
  const must = places.filter((p) => trip.mustSee?.includes(p.title)).map((p) => p.title);
  return `You are researching a trip before it gets planned. Use the web_search and fetch_page tools to find facts that matter for these dates:
- opening hours and closing days of the must-see places on the trip dates, and current ticket prices
- festivals, events and public holidays in these places during the trip
- how to get between the cities (train/bus options, travel times, prices)
- anything else date-dependent for the travelers' interests

Trip: ${tripLine(trip)}.
Travelers: ${trip.travelers}. Interests: ${trip.interests || "none given"}. Notes: ${trip.notes || "none"}.
${must.length ? `Must-see places: ${must.join(", ")}.` : ""}

You can make up to ${MAX_LOOKUPS} tool calls, so be thorough: when you come across places or events worth including, look those up too. Prefer official websites, and read the most useful pages with fetch_page instead of relying on snippets. Short search queries work best. Never guess web addresses: only fetch URLs that appeared in search results or in the "Links on this page" list of a page you read (follow those links to reach opening-hours or ticket pages). When you are done, reply with a concise summary of your findings as "- " bullet points, each ending with its source URL in brackets. Don't plan the itinerary itself.`;
}

interface ResearchOptions extends Omit<RoundContext, "messages"> { trip: Trip; places: Place[]; onEvent: OnEvent }

/** Runs the research conversation; returns its findings and the pages read. Throws "NO_TOOLS" if the model can't use tools. */
export async function localResearch(o: ResearchOptions): Promise<{ notes: string; urls: string[] }> {
  const { kind, base, model, onEvent } = o;
  const messages: any[] = [{ role: "user", content: researchPrompt(o.trip, o.places) }];
  onEvent({
    type: "prompt", label: "Research prompt",
    info: `Sent to ${serverName(kind, base)} · model: ${model} · tools: web_search, fetch_page (run by the planner) · temperature 0.3`
      + `${kind === "ollama" ? ` · context ${RESEARCH_CTX.toLocaleString()} tokens` : ""} · up to ${MAX_LOOKUPS} lookups. ${kind === "ollama" ? "Ollama adds the model's own system prompt, if it has one." : ""}`,
    text: messages[0].content,
  });
  const urls: string[] = [];
  let lookups = 0;
  onEvent({ type: "status", text: "Researching online…" });

  const runTool = async (c: ToolCall) => {
    if (lookups >= MAX_LOOKUPS) return "Lookup limit reached; summarize what you have.";
    if (c.name === "web_search" && c.args.query) {
      lookups++;
      onEvent({ type: "search", query: c.args.query });
      return webSearch(c.args.query).catch((e) => `Search failed: ${e.message}`);
    }
    if (c.name === "fetch_page" && c.args.url) {
      lookups++;
      onEvent({ type: "fetch", url: c.args.url });
      urls.push(c.args.url);
      return fetchPage(c.args.url).catch((e) => `Fetch failed: ${e.message}`);
    }
    return "Unknown tool or missing argument.";
  };

  const maxRounds = MAX_LOOKUPS + 2;
  for (let round = 0; round < maxRounds; round++) {
    // The last round has no tools, so the model has to write its summary.
    const allowTools = lookups < MAX_LOOKUPS && round < maxRounds - 1;
    const { content, calls } = await chatRound({ ...o, messages }, allowTools);
    if (!calls.length) return { notes: content.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), urls };
    for (const c of calls) {
      const result = await runTool(c);
      onEvent({ type: "prompt", label: `Result of ${c.name}(${c.args.query || c.args.url || ""})`, text: result });
      messages.push(kind === "ollama" ? { role: "tool", tool_name: c.name, content: result } : { role: "tool", tool_call_id: c.id, content: result });
    }
  }
  return { notes: "", urls };
}
