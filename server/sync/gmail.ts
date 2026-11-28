// Gmail, read-only, for booking confirmations in the trip chat: a connected account's inbox, its booking emails, its
// emails with PDFs or a search, and one email to read (its HTML, made safe to show) and attach (.eml). The accounts are
// the person's own sign-ins (google.ts). Nothing is sent, changed, deleted or marked as read.
import { readEmail } from "../trip/attachments";
import * as g from "./google";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** What looks like a booking, in a few languages, from the last year. */
export const BOOKINGS = "newer_than:1y {subject:booking subject:reservation subject:confirmation subject:ticket subject:itinerary subject:Buchung subject:Reservierung subject:Bestätigung}";
const FILES = "has:attachment filename:pdf";
const MAX_BYTES = 10_000_000, PER_PAGE = 25;

export interface Mail { id: string; threadId: string; subject: string; from: string; fromEmail: string; date: string; snippet: string; unread: boolean; attachment: boolean }

async function get(account: string, path: string): Promise<any> {
  const res = await g.gmailGet(account, `${API}${path}`);
  const json: any = await res.json().catch(() => ({}));
  if (res.ok) return json;
  const msg = String(json?.error?.message || "");
  if (/has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(msg + JSON.stringify(json?.error?.errors || [])))
    throw new Error("The Gmail API isn't switched on for your Google project (Settings → Accounts → Google → Change or see the steps).");
  if (res.status === 403) throw new Error(`Google didn't allow reading this mail${msg ? `: ${msg.slice(0, 160)}` : ""}`);
  throw new Error(`Gmail answered ${res.status}${msg ? `: ${msg.slice(0, 160)}` : ""}`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const plain = (s: unknown) => String(s || "").replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ENTITIES[e]).replace(/[​-‏͏]/g, "").trim();
const person = (s: string) => ({ name: s.replace(/\s*<[^>]*>$/, "").replace(/^"|"$/g, "").trim(), email: /<([^>]+)>/.exec(s)?.[1] || (s.includes("@") ? s.trim() : "") });
const when = (ms: unknown) => (ms ? new Date(Number(ms)).toISOString() : "");
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A page of emails, newest first: what `query` finds (Gmail's own search words work), else the view's (the inbox, the
 *  booking emails, the emails with PDFs). `next`: the page after it ("" at the end). */
export async function listMail(account: string, o: { query?: string; view?: string; page?: string; max?: number } = {}): Promise<{ mails: Mail[]; next: string }> {
  const query = (o.query || "").trim().slice(0, 300);
  const which: Record<string, string> = query ? { q: query } : o.view === "bookings" ? { q: BOOKINGS } : o.view === "files" ? { q: FILES } : { labelIds: "INBOX" };
  const params = new URLSearchParams({ maxResults: String(o.max || PER_PAGE), ...which, ...(o.page && /^[\w-]{1,100}$/.test(o.page) ? { pageToken: o.page } : {}) });
  const found = await get(account, `/messages?${params}`);
  const ids: string[] = (found.messages || []).map((m: any) => String(m.id)).filter((id: string) => /^[\w-]+$/.test(id));
  const mails = await Promise.all(ids.map(async (id): Promise<Mail> => {
    const m = await get(account, `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`);
    const header = (name: string) => plain((m.payload?.headers || []).find((h: any) => String(h.name).toLowerCase() === name)?.value);
    const from = person(header("from"));
    return {
      id, threadId: /^[\w-]+$/.test(String(m.threadId || "")) ? String(m.threadId) : id, subject: header("subject") || "(no subject)", from: from.name || from.email, fromEmail: from.email,
      date: when(m.internalDate), snippet: plain(m.snippet), unread: (m.labelIds || []).includes("UNREAD"),
      attachment: (m.payload?.parts || []).some((p: any) => p?.filename) || /multipart\/mixed/i.test(String(m.payload?.mimeType || "")),
    };
  }));
  return { mails, next: String(found.nextPageToken || "") };
}

/**
 * An email's HTML, made safe to show (the page also shows it in a sandbox with no scripts and a policy that blocks
 * anything from the web until the person loads its images): no scripts, frames, forms' targets, meta tags (a refresh),
 * <base> or <link>, no event handlers or javascript: links. Its own pictures ("cid:") are put in as data. `remote`: it
 * has pictures or styles from the web, which would tell the sender it was opened.
 */
export function safeEmailHtml(html: string, images: Record<string, string> = {}) {
  const out = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|iframe|frame|frameset|object|embed|applet|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|iframe|frame|frameset|object|embed|applet|meta|base|link|form|input|button|textarea|select)\b[^>]*>/gi, "")
    .replace(/\s(on[a-z]+|srcdoc|formaction|action)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|background|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"')
    .replace(/(["'(=]\s*)cid:([^"')\s>]+)/gi, (_m, before: string, id: string) => `${before}${images[id] || images[decodeURIComponent(id)] || ""}`);
  const remote = /\b(src|background|srcset|poster)\s*=\s*["']?\s*(https?:)?\/\//i.test(out) || /url\(\s*["']?\s*(https?:)?\/\//i.test(out);
  return { html: out, remote };
}

/** A text-only email as HTML: its words, with its web addresses as links. */
const textHtml = (text: string) => `<pre class="plain">${escHtml(text).replace(/https?:\/\/[^\s<>"]+/g, (u) => `<a href="${u}">${u}</a>`)}</pre>`;

/** An email (.eml) to show: its sender, subject and date, its safe HTML, and its attachments' names. */
export function mailView(buf: Buffer, fallback = { snippet: "", date: "" }) {
  const mail = readEmail(buf);
  // (The text starts with the headers it was read with: Subject, From, Date, then a blank line.)
  const cut = mail.text.indexOf("\n\n"), head = cut < 0 ? mail.text : mail.text.slice(0, cut);
  const header = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(head)?.[1]?.trim() || "";
  const to = /^to:[ \t]*(.*)$/im.exec(buf.toString("utf8", 0, Math.min(buf.length, 30_000)).split(/\r?\n\r?\n/)[0])?.[1] || "";
  const subject = header("Subject"), from = person(header("From")), sent = new Date(header("Date"));
  const shown = mail.html.trim() ? safeEmailHtml(mail.html, mail.images) : { html: textHtml(cut < 0 ? "" : mail.text.slice(cut + 2)), remote: false };
  const name = (subject || plain(fallback.snippet)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim() || "Email";
  return {
    name: `${name}.eml`, subject: subject || "(no subject)", from: from.name || from.email, fromEmail: from.email, to: plain(to).slice(0, 200),
    date: fallback.date || (isNaN(sent.getTime()) ? "" : sent.toISOString()), html: shown.html.slice(0, 2_000_000), remote: shown.remote, attachments: mail.files.slice(0, 20),
  };
}

/** One email from Gmail: to show (mailView), and whole as a .eml file named after its subject. */
export async function readMail(account: string, id: string) {
  if (!/^[\w-]{6,40}$/.test(id)) throw new Error("No such email.");
  const m = await get(account, `/messages/${id}?format=raw`);
  const buf = Buffer.from(String(m.raw || ""), "base64url");
  if (!buf.length) throw new Error("That email is empty.");
  if (buf.length > MAX_BYTES) throw new Error("That email is too big (10 MB at most). Attach its PDF or a screenshot instead.");
  return { ...mailView(buf, { snippet: String(m.snippet || ""), date: when(m.internalDate) }), data: buf.toString("base64"), threadId: /^[\w-]+$/.test(String(m.threadId || "")) ? String(m.threadId) : id };
}
