// Turning a fetched page into text a model can use, the way Claude's own web fetch does it: the structure kept
// (headings, lists, table rows, link text), the main content first, and the structured data sites publish for search
// engines (opening hours, events, prices). Long pages are cut down to the parts that match what the model is looking
// for instead of just their first few thousand characters. PDFs (timetables, price lists) are read too, as far as
// their text can be pulled out without a PDF library.
import zlib from "node:zlib";

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", euro: "€", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', middot: "·", raquo: "»", laquo: "«", bull: "•", times: "×", deg: "°", copy: "©", reg: "®", trade: "™", shy: "", ensp: " ", emsp: " ", thinsp: " ", iacute: "í", oacute: "ó", aacute: "á", uacute: "ú", ntilde: "ñ", ccedil: "ç", ecirc: "ê", acirc: "â", ocirc: "ô", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à" };
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m);

/** The page's main part: <main> or <article> when they hold most of the text, else the body. */
function mainPart(html: string) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || html;
  for (const tag of ["main", "article"]) {
    const m = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (m && m[1].replace(/<[^>]+>/g, "").trim().length > 400) return m[1];
  }
  return body;
}

/** HTML as light Markdown: "## " headings, "- " list items, "a | b" table rows, paragraphs on their own lines. */
export function htmlToText(html: string) {
  let s = mainPart(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Attributes aren't needed, and can hold ">" in quotes (Wikipedia puts JSON there), which would break the rest.
    .replace(/<([a-zA-Z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g, "<$1>")
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template|button|select|dialog)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(aside)\b[^>]*(cookie|consent|newsletter)[^>]*>[\s\S]*?<\/aside>/gi, " ");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${"#".repeat(Math.min(Number(n) + 1, 4))} ${t}\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)>\s*/gi, " | ")
    .replace(/<tr\b[^>]*>/gi, "\n")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|ul|ol|table|tbody|thead|dl|dt|dd|blockquote|figure|figcaption|address)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const lines = decodeEntities(s).split("\n").map((l) => l.replace(/[ \t ]+/g, " ").replace(/\s*\|\s*$/, "").trim());
  const out: string[] = [];
  for (const l of lines) {
    if (!l || l === "-" || l === "|") { if (out.at(-1) !== "") out.push(""); continue; }
    if (l !== out.at(-1)) out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const pageTitle = (html: string) => decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();

const WEEKDAY = (d: unknown) => String(d).replace(/^https?:\/\/schema\.org\//, "");

/** What sites tell search engines about themselves (schema.org JSON-LD): opening hours, events, prices, address. */
export function structuredData(html: string): string[] {
  const out: string[] = [];
  const walk = (o: any, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 4 || out.length > 25) return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, depth)); return; }
    if (o["@graph"]) walk(o["@graph"], depth + 1);
    const type = [o["@type"]].flat().filter(Boolean).join("/");
    const parts: string[] = [];
    if (o.openingHours) parts.push(`opening hours: ${[o.openingHours].flat().join("; ")}`);
    const spec = [o.openingHoursSpecification].flat().filter(Boolean);
    if (spec.length) {
      parts.push(`opening hours: ${spec.map((h: any) => `${[h.dayOfWeek].flat().filter(Boolean).map(WEEKDAY).join(", ") || "days?"} ${h.opens || "?"}–${h.closes || "?"}`
        + `${h.validFrom || h.validThrough ? ` (${h.validFrom || ""}–${h.validThrough || ""})` : ""}`).join("; ")}`);
    }
    if (o.startDate) parts.push(`dates: ${o.startDate}${o.endDate ? ` to ${o.endDate}` : ""}`);
    if (o.eventStatus && !/Scheduled/.test(o.eventStatus)) parts.push(`status: ${WEEKDAY(o.eventStatus)}`);
    const offers = [o.offers].flat().filter(Boolean).flatMap((x: any) => (x.offers ? [x.offers].flat() : [x]));
    if (offers.length) parts.push(`prices: ${offers.slice(0, 6).map((x: any) => [x.name, x.price ?? x.lowPrice, x.priceCurrency].filter((v) => v != null && v !== "").join(" ")).filter(Boolean).join("; ")}`);
    if (o.priceRange) parts.push(`price range: ${o.priceRange}`);
    if (o.isAccessibleForFree != null) parts.push(`free: ${o.isAccessibleForFree}`);
    const addr = o.address && (typeof o.address === "string" ? o.address : [o.address.streetAddress, o.address.postalCode, o.address.addressLocality].filter(Boolean).join(", "));
    if (addr) parts.push(`address: ${addr}`);
    if (o.location?.name) parts.push(`at: ${o.location.name}`);
    if (o.telephone) parts.push(`phone: ${o.telephone}`);
    if (parts.length) out.push(`- ${type || "Thing"}${o.name ? ` "${String(o.name).slice(0, 80)}"` : ""}: ${parts.join(" · ")}`);
    for (const k of ["subEvent", "event", "containsPlace", "location", "mainEntity", "itemListElement", "item"]) if (o[k] && typeof o[k] === "object") walk(o[k], depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* broken JSON-LD */ }
  }
  return [...new Set(out)];
}

// Words that mark the useful parts of a travel page, used when the model doesn't say what it's after.
const USEFUL = /\b(open(ing)?|hours?|closed?|daily|tickets?|prices?|admission|entry|adults?|child(ren)?|€|\$|£|¥|eur|chf|timetable|schedule|depart|book(ing)?|reserv|guided|tour|season|winter|summer|holiday|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?|\d{1,2}[:.]\d{2})\b/gi;
const STOP = new Set("the a an and or of to in on for at by with from is are what when where how much many does do this that its it about page".split(" "));

/** Splits text into sections (by headings and paragraphs), each at most ~900 characters. */
function sections(text: string) {
  const out: string[] = [];
  let cur = "";
  for (const block of text.split(/\n(?=#{2,4} )|\n\n/)) {
    if (cur && (cur.length + block.length > 900 || /^#{2,4} /.test(block))) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${block}` : block;
    while (cur.length > 1400) { out.push(cur.slice(0, 900)); cur = cur.slice(900); }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The text cut to `budget` characters: all of it when it fits; otherwise the start of the page, then the sections
 * that best match what the model is looking for (or, without that, the ones about hours, prices and dates), in page
 * order, with "[…]" where something was left out.
 */
export function focusText(text: string, lookingFor = "", budget = 6000) {
  if (text.length <= budget) return text;
  const parts = sections(text);
  const words = lookingFor.toLowerCase().split(/[^\p{L}\p{N}€$]+/u).filter((w) => w.length > 2 && !STOP.has(w));
  const score = (p: string) => {
    const low = p.toLowerCase();
    const asked = words.reduce((n, w) => n + (low.includes(w) ? 3 + Math.min(3, low.split(w).length - 2) : 0), 0);
    return asked + Math.min(6, (p.match(USEFUL) || []).length) * (words.length ? 0.5 : 1);
  };
  const keep = new Set<number>();
  let used = 0;
  // The start of the page (what it is), up to ~1200 characters.
  for (let i = 0; i < parts.length && used < 1200; i++) { keep.add(i); used += parts[i].length; }
  const ranked = parts.map((p, i) => ({ i, s: score(p) })).filter((x) => !keep.has(x.i) && x.s > 0).sort((a, b) => b.s - a.s);
  for (const { i } of ranked) {
    if (used + parts[i].length > budget) continue;
    keep.add(i); used += parts[i].length;
  }
  let out = "", last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    out += (out ? (i === last + 1 ? "\n\n" : "\n\n[…]\n\n") : "") + parts[i];
    last = i;
  }
  return out + (last < parts.length - 1 ? "\n\n[…]" : "");
}

// ---- PDFs ----

/** A PDF string literal's text: "(Opening hours\) 9\\-17)" → "Opening hours) 9\-17". */
function pdfString(s: string) {
  return s.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_m, e: string) =>
    e === "n" ? "\n" : e === "r" ? "" : e === "t" ? " " : e === "b" || e === "f" ? "" : /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : e);
}

/** Text drawn by one content stream: the strings of Tj/TJ/'/", with line breaks where the text moves to a new line. */
function streamText(content: string) {
  let out = "";
  const re = /\((?:\\[\s\S]|[^\\)])*\)\s*(?:Tj|'|")|\[((?:\((?:\\[\s\S]|[^\\)])*\)|[^\]])*)\]\s*TJ|\bT\*|\b-?[\d.]+\s+(-?[\d.]+)\s+T[dD]\b|\bET\b/g;
  for (const m of content.matchAll(re)) {
    const op = m[0];
    if (op.startsWith("(")) out += pdfString(op.slice(1, op.lastIndexOf(")")));
    else if (op.startsWith("[")) {
      for (const p of m[1].matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)|(-?[\d.]+)/g)) {
        if (p[1] != null) out += pdfString(p[1]);
        else if (Number(p[2]) < -180) out += " "; // a wide gap between letters is a space
      }
    } else if (op === "ET" || op === "T*" || (m[2] != null && Number(m[2]) !== 0)) out += "\n";
  }
  return out;
}

/** The text of a PDF, as far as it can be read without a PDF library ("" when it can't: scanned or font-encoded). */
export function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  let text = "";
  for (const m of raw.matchAll(/<<((?:(?!>>\s*stream)[\s\S]){0,2000})>>\s*stream\r?\n/g)) {
    const start = m.index! + m[0].length, end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const dict = m[1];
    if (/\/(Image|XObject|Font|Metadata)\b|\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType)/.test(dict) && !/\/Contents/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { continue; } }
    } else if (/\/Filter/.test(dict)) continue; // other encodings (images, fonts) aren't text
    const s = data.toString("latin1");
    if (/\b(Tj|TJ)\b/.test(s)) text += streamText(s) + "\n";
  }
  text = text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // Garbage (glyph codes instead of letters) when the fonts use their own encoding: say it couldn't be read.
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return text.length >= 40 && letters / text.length > 0.55 ? text : "";
}
