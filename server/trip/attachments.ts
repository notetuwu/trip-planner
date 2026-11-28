// Files attached to a chat message (a booking confirmation as a PDF, an email saved from the mail program, a text file),
// made ready for the model: text as text, PDFs as they are (ask.ts hands them to models that read PDFs, and their text
// to the others). Pictures go separately, as before. No PDF or mail library: emails are plain MIME.
import { htmlToText } from "../research/page-text";

export interface ChatFile { name: string; data: string }
export interface PdfFile { name: string; data: string }
export interface Attachments { texts: { name: string; text: string }[]; pdfs: PdfFile[] }

const MAX_FILES = 4, MAX_DATA = 14_000_000, MAX_TEXT = 20_000;
export const READABLE = /\.(pdf|eml|txt|html?|ics|csv|md|json)$/i;

/** At most 4 files of the kinds that can be read, each up to about 10 MB. */
export function cleanFiles(files: unknown): ChatFile[] {
  if (!Array.isArray(files)) return [];
  return files.filter((f: any) => f && typeof f.name === "string" && READABLE.test(f.name) && typeof f.data === "string" && f.data.length <= MAX_DATA && /^[A-Za-z0-9+/]*=*$/.test(f.data.slice(0, 200)))
    .slice(0, MAX_FILES).map((f: any) => ({ name: f.name.replace(/[\r\n"<>]/g, " ").slice(0, 160), data: f.data }));
}

const decode = (bytes: Buffer, charset = "utf-8") => { try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return bytes.toString("utf8"); } };
/** Quoted-printable and base64, as mail bodies are sent. */
function transfer(body: string, how: string): Buffer {
  if (/base64/i.test(how)) return Buffer.from(body.replace(/\s+/g, ""), "base64");
  if (/quoted-printable/i.test(how)) return Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
  return Buffer.from(body, "latin1");
}
/** A header with encoded words ("=?utf-8?B?…?=") in plain text. */
const words = (s: string) => s.replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_m, charset, how, text) =>
  decode(how.toLowerCase() === "b" ? Buffer.from(text, "base64") : transfer(text.replace(/_/g, " "), "quoted-printable"), charset));

interface Part { headers: Record<string, string>; body: string }
function split(raw: string): Part {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at), headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] ??= m[2];
  }
  return { headers, body: at < 0 ? "" : raw.slice(at).replace(/^\r?\n\r?\n/, "") };
}

/** An email (.eml) as the text to read (its headers and body) and the PDFs attached to it. */
export function readEmail(buf: Buffer): { text: string; pdfs: PdfFile[]; html: string; images: Record<string, string>; files: string[] } {
  // (As latin1: every byte stays what it is until each part's own encoding and character set are applied.)
  const plain: string[] = [], html: string[] = [], pdfs: PdfFile[] = [], files: string[] = [];
  /** Pictures inside the email ("cid:" in its HTML), as data addresses, by their Content-ID. */
  const images: Record<string, string> = {};
  const walk = ({ headers, body }: Part, depth: number) => {
    const type = headers["content-type"] || "text/plain", disposition = headers["content-disposition"] || "";
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (/^multipart\//i.test(type) && boundary) {
      if (depth < 6) for (const piece of body.split(`--${boundary}`).slice(1)) { if (!piece.startsWith("--")) walk(split(piece.replace(/^\r?\n/, "")), depth + 1); }
      return;
    }
    if (/^message\/rfc822/i.test(type)) { if (depth < 6) walk(split(body), depth + 1); return; }
    const bytes = transfer(body, headers["content-transfer-encoding"] || "");
    const name = words(/(?:filename|name)="?([^";]+)"?/i.exec(`${disposition}; ${type}`)?.[1] || "");
    const cid = (/<([^>]+)>/.exec(headers["content-id"] || "")?.[1] || headers["content-id"] || "").trim();
    const picture = /^image\/(png|jpe?g|gif|webp)\b/i.exec(type)?.[0].toLowerCase();
    if (cid && picture && bytes.length < 3_000_000) { images[cid] = `data:${picture};base64,${bytes.toString("base64")}`; if (!/^attachment/i.test(disposition)) return; }
    if (name) files.push(name);
    if (/application\/pdf/i.test(type) || /\.pdf$/i.test(name)) { if (pdfs.length < MAX_FILES) pdfs.push({ name: name || "attachment.pdf", data: bytes.toString("base64") }); return; }
    if (/^attachment/i.test(disposition)) return;
    const text = decode(bytes, /charset="?([\w-]+)/i.exec(type)?.[1]);
    if (/^text\/plain/i.test(type)) plain.push(text); else if (/^text\/html/i.test(type)) html.push(text);
  };
  const top = split(buf.toString("latin1"));
  walk(top, 0);
  const head = ["subject", "from", "date"].filter((k) => top.headers[k]).map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${words(decode(Buffer.from(top.headers[k], "latin1")))}`);
  // The HTML version often holds more than the plain one ("view this email in your browser"): the longer of the two.
  const a = plain.join("\n").trim(), b = html.length ? htmlToText(html.join("\n")).trim() : "";
  return { text: `${head.join("\n")}\n\n${b.length > a.length * 1.5 ? b : a || b}`.trim(), pdfs, html: html.join("\n"), images, files };
}

/** The attached files as texts and PDFs (an email's attached PDFs among them). */
export function readFiles(files: ChatFile[]): Attachments {
  const out: Attachments = { texts: [], pdfs: [] };
  for (const f of files) {
    const buf = Buffer.from(f.data, "base64");
    if (/\.pdf$/i.test(f.name)) out.pdfs.push(f);
    else if (/\.eml$/i.test(f.name)) {
      const mail = readEmail(buf);
      out.texts.push({ name: f.name, text: mail.text.slice(0, MAX_TEXT) });
      out.pdfs.push(...mail.pdfs);
    } else {
      const text = decode(buf);
      out.texts.push({ name: f.name, text: (/\.html?$/i.test(f.name) ? htmlToText(text) : text).slice(0, MAX_TEXT) });
    }
  }
  out.pdfs = out.pdfs.slice(0, MAX_FILES);
  return out;
}
