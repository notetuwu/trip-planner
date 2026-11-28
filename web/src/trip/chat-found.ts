// What the trip chat's searches show under an answer (server/trip/chat-find.ts): the documents it found, to open (a
// picture right there), and the emails, to read or attach to the next message. And before a model that isn't on this
// computer gets to search the documents or Gmail, the card that asks.
import { api, esc, toast } from "../core/dom";
import { fmtShort } from "../core/format";
import { icon } from "../core/icons";
import { state } from "../core/state";
import { docUrl } from "./chat-docs";
import { showEmail } from "./email-view";

export type Found =
  | { kind: "doc"; ref: string; name: string; note?: string }
  | { kind: "mail"; ref: string; account: string; id: string; subject: string; from: string; date: string };
export interface SearchAsk { searches: { kind: string; args: string[] }[]; declined?: boolean }

/** Which booking each kept file is on, by file name: the search matches that too. */
export function docLinks() {
  const out: Record<string, string> = {};
  for (const b of state.bookings || []) for (const n of b.docs || []) out[n] = [out[n], `${b.name}, ${b.date}${b.where ? `, ${b.where}` : ""}`].filter(Boolean).join("; ");
  return out;
}

export const foundNames = (list: Found[]) => list.map((f) => (f.kind === "doc" ? f.name : `the email "${f.subject}"`)).join(", ");

const row = (open: string, sub: string, extra = "") => `<div class="cp-found-item">${open}${sub ? `<span class="hint">${esc(sub)}</span>` : ""}${extra}</div>`;
const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? fmtShort(iso.slice(0, 10)) : "");

export function foundHtml(list: Found[] | undefined, k: number) {
  if (!list?.length) return "";
  return `<div class="cp-found">${list.map((f, i) => {
    if (f.kind === "mail") {
      return row(`<span class="cp-file open" role="button" tabindex="0" data-found="${k}:${i}" title="Read the email">${icon("mail")}<span>${esc(f.subject)}</span></span>`,
        [f.from, day(f.date)].filter(Boolean).join(" · "), `<button type="button" class="link-btn" data-found-attach="${k}:${i}" title="Attach it to your next message: to add it to the trip, or to keep it with it">Attach</button>`);
    }
    const url = esc(docUrl(f.name));
    const picture = /\.(jpe?g|png|webp|gif)$/i.test(f.name) ? `<img src="${url}" alt="" data-zoom title="Click to see it big">` : "";
    return row(`<a class="cp-file" href="${url}" target="_blank" rel="noopener" title="Open it">${icon("file")}<span>${esc(f.name)}</span></a>`, f.note || "", picture);
  }).join("")}</div>`;
}

/** The question before a search on message `k`; `to`: who gets what it finds. Buttons only while it's the latest
 *  message. */
export function searchAskHtml(a: SearchAsk, k: number, latest: boolean, to: string) {
  if (a.declined || !latest) return `<div class="cp-docs"><span class="hint">Not searched.</span></div>`;
  const docs = a.searches.some((s) => s.kind === "docs"), mail = a.searches.some((s) => s.kind === "gmail");
  const what = [docs ? "the trip's documents" : "", mail ? "your Gmail" : ""].filter(Boolean).join(" and ");
  const words = [...new Set(a.searches.map((s) => `“${s.args.join(" ")}”`))].join(", ");
  const sent = [docs ? "the documents' names and the text of the best matches (when none matches, the start of up to 20)" : "",
    mail ? "the senders, subjects and text of a few matching emails (and their PDFs)" : ""].filter(Boolean).join(", and ");
  const button = docs && mail ? "Search both" : mail ? "Search Gmail" : "Search documents";
  return `<div class="cp-docs cp-search-ask"><b>${icon(mail ? "mail" : "file")} Search ${esc(what)}?</b>
    <span class="hint">Search: ${esc(words)}. To answer, ${esc(sent)} go to ${esc(to || "the model's provider")}. Allowing covers this question, including a second try with other words.</span>
    <div class="cp-docs-act"><button type="button" class="btn solid" data-search-ok="${k}">${icon("search")} ${button}</button><button type="button" class="link-btn" data-search-no="${k}">Don't</button></div></div>`;
}

interface Turn { found?: Found[]; searchAsk?: SearchAsk }
interface Actions { attach: (file: File) => void; search: (searches: SearchAsk["searches"]) => void; skip: (k: number) => void }

/** An email found, fetched whole from Gmail as an .eml file. */
async function mailFile(f: Extract<Found, { kind: "mail" }>) {
  const m = await api<{ name: string; data: string }>(`/api/sync/gmail/message?${new URLSearchParams({ account: f.account, id: f.id })}`);
  return new File([Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0))], m.name, { type: "message/rfc822" });
}

export function wireFound(log: HTMLElement, turn: (k: number) => Turn | undefined, on: Actions) {
  const use = (attr: string, run: (file: File) => void) => {
    for (const el of log.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      el.onclick = async () => {
        const [k, i] = el.getAttribute(attr)!.split(":").map(Number), f = turn(k)?.found?.[i];
        if (f?.kind !== "mail") return;
        try { run(await mailFile(f)); } catch (e) { toast(`Couldn't get the email: ${(e as Error).message}`); }
      };
    }
  };
  use("data-found", showEmail);
  use("data-found-attach", on.attach);
  const ok = log.querySelector<HTMLButtonElement>("[data-search-ok]"), no = log.querySelector<HTMLButtonElement>("[data-search-no]");
  if (ok) ok.onclick = () => { const a = turn(Number(ok.dataset.searchOk))?.searchAsk; if (a) on.search(a.searches); };
  if (no) no.onclick = () => on.skip(Number(no.dataset.searchNo));
}
