// Tips as shown: web addresses become links, and vignette / toll tips get the official shops.
import { esc } from "../core/dom";
import { state } from "../core/state";
import { stayLoc } from "../geo/locate";

/** Official online shops for motorway vignettes and toll stickers, by country code. */
const VIGNETTE_SHOPS: Record<string, { name: string; url: string; words: RegExp }> = {
  AT: { name: "ASFINAG shop (Austria)", url: "https://shop.asfinag.at/", words: /austria|österreich|asfinag/i },
  CH: { name: "e-vignette (Switzerland)", url: "https://via.admin.ch/shop/", words: /switzerland|swiss|schweiz/i },
  SI: { name: "e-vinjeta (Slovenia)", url: "https://evinjeta.dars.si/", words: /slovenia|sloven/i },
  CZ: { name: "eDálnice (Czechia)", url: "https://edalnice.gov.cz/", words: /czech/i },
  SK: { name: "eznamka (Slovakia)", url: "https://eznamka.sk/", words: /slovak/i },
  HU: { name: "e-matrica (Hungary)", url: "https://ematrica.nemzetiutdij.hu/", words: /hungar/i },
  BG: { name: "BG TOLL (Bulgaria)", url: "https://web.bgtoll.bg/", words: /bulgaria/i },
  RO: { name: "e-rovinieta (Romania)", url: "https://www.erovinieta.ro/", words: /romania/i },
};

const URL_RE = /https?:\/\/[^\s)\]<>"]+[^\s)\]<>".,;:!?]/g;
const short = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 50);
const link = (url: string, text: string) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;

/** Countries of the stays, for tips that don't say which vignette they mean. */
const tripCcs = () => new Set(state.stays.map((s) => stayLoc(s)?.cc?.toUpperCase()).filter(Boolean) as string[]);

export function tipHtml(tip: string) {
  // Escape the text around the addresses, and turn the addresses into links.
  let html = "", at = 0;
  for (const m of tip.matchAll(URL_RE)) {
    html += esc(tip.slice(at, m.index)) + link(m[0], short(m[0]));
    at = m.index! + m[0].length;
  }
  html += esc(tip.slice(at));
  if (/vignet|vinjet|vignette|maut|toll sticker|e-?matrica|dálnič/i.test(tip)) {
    const named = Object.entries(VIGNETTE_SHOPS).filter(([, s]) => s.words.test(tip));
    const ccs = tripCcs();
    const shops = (named.length ? named : Object.entries(VIGNETTE_SHOPS).filter(([cc]) => ccs.has(cc)))
      .filter(([, s]) => !tip.includes(new URL(s.url).hostname));
    if (shops.length) html += ` <span class="tip-links">Buy: ${shops.map(([, s]) => link(s.url, s.name)).join(" · ")}</span>`;
  }
  return html;
}
