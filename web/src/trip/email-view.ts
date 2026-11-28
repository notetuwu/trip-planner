// Showing an email: in the Gmail window (gmail-picker.ts), and on its own when an attached or kept email is clicked in
// the chat or on a booking (showEmail). The email's own HTML goes into a sandboxed frame without scripts, under a policy
// that blocks everything from the web (pictures, styles, fonts) until "Load images" is pressed: remote pictures would
// tell the sender it was opened. Links open outside the app.
import { api, closeOnBackdrop, esc, toast } from "../core/dom";
import { fmtShort, fmtTime } from "../core/format";
import { icon } from "../core/icons";
import { openOutside } from "../core/window-mode";

/** An email as the server makes it ready to show (server/sync/gmail.ts, mailView). */
export interface EmailView { subject: string; from: string; fromEmail: string; to: string; date: string; html: string; remote: boolean; attachments: string[] }

const pad = (n: number) => String(n).padStart(2, "0");
/** When an email came: the time today, the weekday this week, else the date (and the year when it isn't this year). */
export function when(iso: string, long = false) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date(), time = fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  if (long) return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${time}`;
  if (d.toDateString() === now.toDateString()) return time;
  const days = (now.getTime() - d.getTime()) / 864e5;
  if (days > 0 && days < 6) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.getFullYear() === now.getFullYear() ? fmtShort(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`) : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
const hue = (s: string) => [...s.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 17);
/** A sender's initial in a circle of their own colour. */
export const avatar = (name: string, key: string, size = "") => `<span class="mbx-av ${size}" style="--h:${hue(key || name)}" aria-hidden="true">${esc((name.trim().match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase())}</span>`;

/** The email as a document for the frame: the policy first, so nothing from the web loads before it applies. (Pictures
 *  from the web that are blocked take their room but show no broken-picture sign.) */
const frameDoc = (html: string, images: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${images ? " https: http:" : ""}; img-src data:${images ? " https: http:" : ""}; font-src data:; form-action 'none'">
<meta name="referrer" content="no-referrer"><base target="_blank">
<style>html{color-scheme:light}body{margin:0;padding:20px 22px;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f1f1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%}table{max-width:100%}pre.plain{margin:0;white-space:pre-wrap;font:inherit}a{color:#1a62d6}${images ? "" : "img:not([src^=\"data:\"]){visibility:hidden}"}</style>
</head><body>${html}</body></html>`;

/** The email's header (subject, sender, date, attachments), the images notice and its paper, for a scrolling pane. */
export function emailHtml(m: EmailView, images: boolean) {
  return `<h2 class="mbx-subject">${esc(m.subject)}</h2>
    <div class="mbx-sender">${avatar(m.from || m.fromEmail, m.fromEmail || m.from, "lg")}
      <div><b>${esc(m.from || m.fromEmail || "(unknown)")}</b>${m.fromEmail && m.fromEmail !== m.from ? ` <span class="hint">&lt;${esc(m.fromEmail)}&gt;</span>` : ""}${m.to ? `<div class="hint">to ${esc(m.to)}</div>` : ""}</div>
      <time>${esc(when(m.date, true))}</time></div>
    ${m.attachments.length ? `<div class="mbx-files">${m.attachments.map((n) => `<span class="cp-file">${icon("file")}<span>${esc(n)}</span></span>`).join("")}</div>` : ""}
    ${m.remote && !images ? `<div class="mbx-banner">${icon("eyeOff")}<span>Images from the web are hidden: loading them can tell the sender you opened this.</span><button type="button" class="btn" data-mbx-images>Load images</button></div>` : ""}
    <div class="mbx-paper"><iframe title="The email" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></div>`;
}

/** Fills the frame in `root` and wires it: as tall as the email (so the pane scrolls as one), links outside the app, and
 *  "Load images" (which calls `withImages` to draw it again with them). */
export function wireEmail(root: HTMLElement, m: EmailView, images: boolean, withImages: () => void) {
  const frame = root.querySelector<HTMLIFrameElement>(".mbx-paper iframe")!;
  const fit = () => { try { const b = frame.contentDocument!.body; frame.style.height = `${Math.max(120, Math.ceil(b.getBoundingClientRect().height), b.scrollHeight)}px`; } catch { /* not ours */ } };
  frame.onload = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    fit();
    const link = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") || "";
      if (/^(https?:|mailto:)/i.test(href)) openOutside(href);
    };
    doc.addEventListener("click", link, true);
    doc.addEventListener("auxclick", link, true);
    for (const img of Array.from(doc.images)) img.addEventListener("load", fit);
    try { new ResizeObserver(fit).observe(doc.documentElement); } catch { /* older browsers: sized once */ }
  };
  frame.srcdoc = frameDoc(m.html, images);
  root.querySelector<HTMLButtonElement>("[data-mbx-images]")?.addEventListener("click", withImages);
}

/** An email file (.eml) opened to read, in a window of its own. */
export async function showEmail(file: File) {
  let m: EmailView;
  try {
    const data = await new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = () => fail(new Error("Couldn't read the file.")); r.readAsDataURL(file); });
    m = await api<EmailView>("/api/mail/view", { method: "POST", body: JSON.stringify({ data }) });
  } catch (e) { toast(`Couldn't open the email: ${(e as Error).message}`); return; }
  const d = document.createElement("dialog");
  d.className = "keys-dialog mail-view";
  document.body.append(d);
  closeOnBackdrop(d);
  d.addEventListener("close", () => d.remove());
  const draw = (images: boolean) => {
    d.innerHTML = `<div class="mbx-read-bar">${icon("mail")}<b>${esc(file.name)}</b><form method="dialog"><button class="icon-btn" title="Close (Esc)" aria-label="Close">${icon("x")}</button></form></div>
      <div class="mbx-read-scroll">${emailHtml(m, images)}</div>`;
    wireEmail(d, m, images, () => draw(true));
  };
  draw(false);
  d.showModal();
}
