// Finding a booking's document or email for the trip chat: "LOOKUP: docs | words" searches the files kept with the trip
// (their names, the booking they're on and what they say), "LOOKUP: gmail | search" the connected Gmail accounts. Each
// result gets a short name ("doc1", "mail2"); the model ends its reply with "SHOW: doc1" and the page shows those.
// A model that isn't on this computer only gets documents or mail once the traveler said so (see companion.ts).
import { pdfText } from "../research/page-text";
import { type DocFile, tripDocs } from "../routes/docs";
import { listMail, readMail } from "../sync/gmail";
import { gmailAccounts } from "../sync/google";
import { readEmail, readFiles } from "./attachments";

export type Found =
  | { kind: "doc"; ref: string; name: string; note?: string }
  | { kind: "mail"; ref: string; account: string; id: string; subject: string; from: string; date: string };

/** What one reply's searches have turned up so far, and what they need. */
export interface FindContext {
  /** The trip's save name ("" while it isn't saved: it has no documents then). */
  trip: string;
  /** Which booking each kept file is on, by file name ("Ferry to Split, 2027-06-02"). */
  links: Record<string, string>;
  found: Found[];
}

const MAX_DOCS = 80, MAX_SHOWN = 5, MAX_LISTED = 20, EXCERPT = 1500, MAX_TEXT = 20_000;

/** Lower case without accents, so "Zurich" finds "Zürich". */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
export const searchWords = (q: string) => [...new Set(fold(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];

/** How well a document fits the words: how many of them it has, and how much (its name and booking count most). */
export function scoreDoc(words: string[], name: string, note: string, text: string) {
  const n = fold(name), l = fold(note), t = fold(text);
  let hits = 0, score = 0;
  for (const w of words) {
    const s = (n.includes(w) ? 5 : 0) + (l.includes(w) ? 4 : 0) + Math.min(3, t.split(w).length - 1);
    if (s) { hits++; score += s; }
  }
  return { hits, score };
}

/** The start of a document (where a confirmation says what it is) and, further down, where the words first are. */
export function excerpt(text: string, words: string[], size = EXCERPT) {
  const flat = text.replace(/\n{2,}/g, "\n").trim();
  if (flat.length <= size) return flat;
  // (Folding keeps the length for ordinary accented letters, close enough to cut around a hit.)
  const folded = fold(flat), at = Math.min(...words.map((w) => folded.indexOf(w)).filter((i) => i > size * 0.6), Infinity);
  return Number.isFinite(at) ? `${flat.slice(0, size * 0.6)}\n…\n${flat.slice(Math.max(0, at - 150), at + size * 0.4)}…` : `${flat.slice(0, size)}…`;
}

/** The words in a file: an email's (with its attached PDFs'), a PDF's, a text file's ("" for a picture or a scan). */
export function docText(name: string, data: Buffer) {
  if (!/\.(pdf|eml|txt|html?|ics|csv|md)$/i.test(name)) return "";
  const read = readFiles([{ name, data: data.toString("base64") }]);
  return [...read.texts.map((t) => t.text), ...read.pdfs.map((p) => pdfText(Buffer.from(p.data, "base64")))].join("\n").trim().slice(0, MAX_TEXT);
}

/** Texts already read, so a second search doesn't download everything again. */
const texts = new Map<string, string>();
async function textOf(f: DocFile) {
  const known = texts.get(f.key);
  if (known != null) return known;
  if (!/\.(pdf|eml|txt|html?|ics|csv|md)$/i.test(f.name)) return "";
  try {
    const text = docText(f.name, await f.read());
    if (texts.size > 500) texts.clear();
    texts.set(f.key, text);
    return text;
  } catch { return ""; }
}

/** The result's short name: the same one when it was found before. */
function ref(ctx: FindContext, item: Omit<Extract<Found, { kind: "doc" }>, "ref"> | Omit<Extract<Found, { kind: "mail" }>, "ref">) {
  const same = ctx.found.find((f) => (item.kind === "doc" ? f.kind === "doc" && f.name === item.name : f.kind === "mail" && f.id === item.id));
  if (same) return same.ref;
  const r = `${item.kind}${ctx.found.filter((f) => f.kind === item.kind).length + 1}`;
  ctx.found.push({ ...item, ref: r } as Found);
  return r;
}

export async function searchDocs(query: string, ctx: FindContext) {
  if (!ctx.trip) return "This trip isn't saved yet, so no documents are kept with it.";
  const files = (await tripDocs(ctx.trip)).slice(0, MAX_DOCS);
  if (!files.length) return "No documents are kept with this trip (files attached in the chat can be kept in its docs folder).";
  // "all": what's kept, not a search.
  const everything = /^(all|\*)$/i.test(query.trim()), words = everything ? [] : searchWords(query);
  const all: { f: DocFile; note: string; text: string; hits: number; score: number }[] = [];
  for (let i = 0; i < files.length; i += 5) {
    all.push(...await Promise.all(files.slice(i, i + 5).map(async (f) => {
      const note = ctx.links[f.name] || "", text = await textOf(f);
      return { f, note, text, ...scoreDoc(words, f.name, note, text) };
    })));
  }
  const best = all.filter((d) => d.hits).sort((a, b) => b.hits - a.hits || b.score - a.score || Number(!!b.note) - Number(!!a.note)).slice(0, MAX_SHOWN);
  // Nothing has the words (or it's a scan or picture): the start of each, so it can still be picked.
  const listed = best.length ? best : all.sort((a, b) => Number(!!b.note) - Number(!!a.note)).slice(0, MAX_LISTED);
  const block = (d: (typeof all)[number], size: number) => {
    const r = ref(ctx, { kind: "doc", name: d.f.name, ...(d.note ? { note: d.note } : {}) });
    return `[${r}] ${d.f.name}${d.note ? ` (on the booking: ${d.note})` : ""}\n${d.text ? `<file>\n${excerpt(d.text, words, size).replace(/<\/file>/gi, "")}\n</file>` : "(A picture or a scan: only its name is known.)"}`;
  };
  const out = listed.map((d) => block(d, best.length ? EXCERPT : 250));
  const others = all.filter((d) => !listed.includes(d)).slice(0, 40).map((d) => `[${ref(ctx, { kind: "doc", name: d.f.name, ...(d.note ? { note: d.note } : {}) })}] ${d.f.name}${d.note ? ` (${d.note})` : ""}`);
  return `${best.length ? `The ${best.length} that fit best:` : everything ? `All ${all.length} kept:` : "None has those words. What's kept:"}\n${out.join("\n\n")}${others.length ? `\n\nAlso kept: ${others.join("; ")}` : ""}`;
}

export async function searchGmail(query: string, ctx: FindContext) {
  const accounts = gmailAccounts().filter((a) => !a.expired);
  if (!accounts.length) return "No Gmail account is connected (or its sign-in expired). It's connected under \"Add from Gmail\" by the message box.";
  const failed: string[] = [];
  const hits = (await Promise.all(accounts.map(async ({ email }) => {
    try { return (await listMail(email, { query, max: MAX_SHOWN })).mails.map((m) => ({ ...m, account: email })); }
    catch (e) { failed.push(`${email}: ${(e as Error).message}`); return []; }
  }))).flat().sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_SHOWN);
  const out = await Promise.all(hits.map(async (m) => {
    const r = ref(ctx, { kind: "mail", account: m.account, id: m.id, subject: m.subject, from: m.from, date: m.date });
    let text = m.snippet;
    try {
      const mail = readEmail(Buffer.from((await readMail(m.account, m.id)).data, "base64"));
      text = [mail.text, ...mail.pdfs.map((p) => pdfText(Buffer.from(p.data, "base64")))].join("\n").slice(0, MAX_TEXT) || text;
    } catch { /* too big or gone: its first words */ }
    return `[${r}] "${m.subject}" from ${m.from}, ${m.date.slice(0, 10)}\n<email>\n${excerpt(text, searchWords(query)).replace(/<\/email>/gi, "")}\n</email>`;
  }));
  const problems = failed.length ? `\n\nCouldn't search: ${failed.join("; ")}` : "";
  return (out.length ? out.join("\n\n") : "No email matches that search. Try fewer words, or alternatives in braces ({ferry ticket}).") + problems;
}

const SHOW = /^[ \t>*`-]*SHOW:[ \t]*(.*?)[ \t`*]*$/gm;
/** A reply without its SHOW line (also half-written, while it streams in). */
export const withoutShow = (text: string) => text.replace(SHOW, "").replace(/\n[ \t]*S(H(O(W)?)?)?$/, "");

/** The results to show under an answer: those on its SHOW line, then every other one it names (a file also without its
 *  ending): whatever the answer mentions can be opened, also when the SHOW line leaves it out or is forgotten. */
export function shownFound(reply: string, found: Found[]): Found[] {
  const picked = [...reply.matchAll(SHOW)].flatMap((m) => m[1].toLowerCase().match(/\b(?:doc|mail)\d+\b/g) || [])
    .map((r) => found.find((f) => f.ref === r)).filter((f): f is Found => !!f);
  // The longest names first, each taken out once seen: "ticket.pdf" isn't found inside "ferry ticket.pdf".
  let text = withoutShow(reply).toLowerCase();
  const label = (f: Found) => (f.kind === "doc" ? f.name : f.subject).toLowerCase();
  const named: { f: Found; at: number }[] = [];
  for (const f of [...found].sort((a, b) => label(b).length - label(a).length)) {
    const stem = f.kind === "doc" ? label(f).replace(/\.\w+$/, "") : "";
    // (A name of a few letters, an email called "Hi", is in any answer: only its SHOW line shows it.)
    const name = [label(f), ...(stem.length >= 8 ? [stem] : [])].find((n) => n.length >= 6 && text.includes(n));
    if (!name) continue;
    named.push({ f, at: text.indexOf(name) });
    text = text.split(name).join(" ".repeat(name.length));
  }
  return [...new Set([...picked, ...named.sort((a, b) => a.at - b.at).map((n) => n.f)])].slice(0, MAX_LISTED);
}
