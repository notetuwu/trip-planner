// "Add from Gmail" in the trip chat: a small read-only mail app laid out like Gmail. On the left the account (a menu to
// switch), the views (inbox, booking emails, emails with PDFs) and your filters: saved searches, one click each. The list
// in the middle (more loads as you scroll), the email on the right as it was sent. Tick several to add them together. Gmail is only asked while this window is open (server/sync/gmail.ts); not connected
// yet, the steps to connect it open first.
//
// The email's own HTML is shown in a sandboxed frame without scripts, under a policy that blocks everything from the web
// (pictures, styles, fonts) until "Load images" is pressed: remote pictures would tell the sender it was opened. Links
// open outside the app.
import { api, closeOnBackdrop, esc, toast } from "../core/dom";
import { type IconName, ext, icon } from "../core/icons";
import { openOutside } from "../core/window-mode";
import { loadSyncStatus } from "../saves/sync-client";
import { addGmail, openConnect } from "../settings/connect-wizard";
import { askText } from "../core/ask";
import { togglePopup } from "../core/menu";
import { avatar, emailHtml, when, wireEmail } from "./email-view";

interface Mail { id: string; threadId: string; subject: string; from: string; fromEmail: string; date: string; snippet: string; unread: boolean; attachment: boolean }
interface Opened { name: string; data: string; threadId: string; subject: string; from: string; fromEmail: string; to: string; date: string; html: string; remote: boolean; attachments: string[] }

const VIEWS: [string, string, IconName][] = [["inbox", "Inbox", "mail"], ["bookings", "Bookings", "ticket"], ["files", "With PDFs", "file"]];
const KEY = "trip-planner-gmail";
/** How the list is sorted. Gmail sends mail newest first, so the others sort what's loaded (more comes as you scroll). */
const SORTS: [string, string, string][] = [
  ["new", "Newest first", ""], ["old", "Oldest first", "Of the emails loaded"], ["unread", "Unread first", ""],
  ["bookings", "Bookings first", "Confirmations, tickets, reservations"], ["attach", "With attachments first", ""], ["from", "Sender A–Z", ""],
];
const remembered = (): { account?: string; view?: string; sort?: string } => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
/** Saved searches ("from:booking.com"), kept in this browser, for every account. */
const FILTERS_KEY = "trip-planner-gmail-filters";
const savedFilters = (): string[] => { try { const v = JSON.parse(localStorage.getItem(FILTERS_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, 30) : []; } catch { return []; } };
const BOOKING = /\b(booking|booked|reservation|reserved|confirm(ation|ed)?|e-?ticket|ticket|itinerary|boarding|check-?in|buchung|reservierung|bestätigung|réservation|prenotazione|reserva)\b/i;

const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function openGmail(attach: (files: File[]) => void) {
  const status = await loadSyncStatus();
  if (!status) { toast("Gmail is only available on the computer the planner runs on"); return; }
  const all = status.gmail || [], accounts = all.filter((a) => !a.expired).map((a) => a.email);
  if (!accounts.length) {
    openConnect("gmail", async () => { if ((await loadSyncStatus())?.gmail?.some((a) => !a.expired)) openGmail(attach); });
    return;
  }
  const last = remembered();
  let account = accounts.includes(last.account || "") ? last.account! : accounts[0];
  let view = VIEWS.some(([v]) => v === last.view) ? last.view! : "inbox";
  let sort = SORTS.some(([s]) => s === last.sort) ? last.sort! : "new";
  /** The emails ticked, by account and id, with what the list knew of them. */
  const picked = new Map<string, { account: string; mail: Mail }>();
  const opened = new Map<string, Opened>();
  const keyOf = (id: string, acc = account) => `${acc}|${id}`;
  let mails: Mail[] = [], current = "", next = "", loading = false, filters = savedFilters();
  const keepFilters = () => { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* private window */ } };

  const d = document.createElement("dialog");
  d.className = "keys-dialog mbx";
  d.innerHTML = `<header class="mbx-head">
      <h3>${icon("mail")}<span>Add from Gmail</span></h3>
      <label class="mbx-search">${icon("search")}<input type="search" placeholder="Search all mail" aria-label="Search all mail" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
      <form method="dialog"><button class="icon-btn" title="Close (Esc)" aria-label="Close">${icon("x")}</button></form>
    </header>
    <div class="mbx-main">
      <nav class="mbx-side" aria-label="Account, views and filters">
        <button type="button" class="mbx-account" data-mbx-account-btn aria-haspopup="menu" aria-expanded="false" title="Switch account"></button>
        ${VIEWS.map(([v, label, ic]) => `<button type="button" class="mbx-nav" data-mbx-view="${v}">${icon(ic)}<span>${label}</span></button>`).join("")}
        <div class="mbx-side-h">Filters</div>
        <div class="mbx-filters"></div>
        <button type="button" class="mbx-nav muted" data-mbx-new-filter title="Save a search to come back to with one click">${icon("plus")}<span>New filter</span></button>
      </nav>
      <section class="mbx-col" aria-label="Emails">
        <div class="mbx-list-head"><b></b><span class="hint"></span><button type="button" class="link-btn" data-mbx-save hidden>${icon("plus")} Save as filter</button><button type="button" class="mbx-sort" data-mbx-sort aria-haspopup="menu" aria-expanded="false" title="Sort the list"></button></div>
        <div class="mbx-list" role="listbox" aria-label="Emails" tabindex="0"></div>
      </section>
      <article class="mbx-read" aria-live="polite"></article>
    </div>
    <footer class="mbx-foot">
      <span class="hint">${icon("lock")} Read-only. Emails you add are read by the chat's model when you send. <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>x</kbd> tick · <kbd>Enter</kbd> add</span>
      <span class="mbx-picked" hidden><b></b><button type="button" class="link-btn" data-mbx-clear>Clear</button><button type="button" class="btn solid" data-mbx-add-picked>${icon("plus")} Add to chat</button></span>
    </footer>`;
  document.body.append(d);
  closeOnBackdrop(d);
  const $d = <T extends HTMLElement = HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const main = $d(".mbx-main"), list = $d(".mbx-list"), reader = $d(".mbx-read"), input = $d<HTMLInputElement>(".mbx-search input");
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ account, view, sort })); } catch { /* private window */ } };

  // ---- The left: accounts and views ----
  const drawSide = () => {
    const q = input.value.trim(), acc = all.find((a) => a.email === account);
    $d("[data-mbx-account-btn]").innerHTML = `${avatar(account, account, "sm")}<span>${esc(account)}</span>${acc?.expired ? icon("warn") : ""}${icon("chevronDown")}`;
    for (const b of d.querySelectorAll<HTMLElement>("[data-mbx-view]")) b.setAttribute("aria-current", String(!q && b.dataset.mbxView === view));
    $d(".mbx-filters").innerHTML = filters.map((f, i) => `<div class="mbx-nav mbx-filter" role="button" tabindex="0" data-mbx-filter="${i}" aria-current="${f === q}" title="${esc(f)}">${icon("search")}<span>${esc(f)}</span><button type="button" class="mbx-filter-x" data-mbx-unfilter="${i}" title="Remove this filter" aria-label="Remove the filter ${esc(f)}">${icon("x")}</button></div>`).join("")
      || `<p class="mbx-side-note">Save searches you use often, like <code>from:booking.com</code>, to switch between them with one click.</p>`;
    $d(".mbx-list-head b").textContent = q ? (filters.includes(q) ? q : `Results for “${q}”`) : VIEWS.find(([v]) => v === view)![1];
    $d(".mbx-list-head .hint").textContent = q ? "all mail" : account;
    $d<HTMLButtonElement>("[data-mbx-save]").hidden = !q || filters.includes(q);
  };
  const searchFor = (q: string) => { input.value = q; current = ""; clearTimeout(typing); drawEmpty(); load(); };
  const newFilter = async () => {
    const q = await askText({ title: "New filter", text: "A search to come back to with one click. Gmail's own words work: from:, subject:, has:attachment, newer_than:30d.", label: "Search", value: input.value.trim(), placeholder: "from:booking.com", ok: "Save", required: true, validate: (v) => (filters.includes(v) ? "You have this filter already." : "") });
    if (!q) return;
    filters = [...filters, q.slice(0, 200)]; keepFilters();
    searchFor(q);
  };

  // ---- The middle: the list ----
  const skeleton = (n: number) => Array.from({ length: n }, () => `<div class="mbx-skel" aria-hidden="true"><span class="mbx-av"></span><div><i></i><i></i></div></div>`).join("");
  const row = (m: Mail) => {
    const k = keyOf(m.id);
    return `<div class="mbx-row${m.unread ? " unread" : ""}${m.id === current ? " on" : ""}${picked.has(k) ? " picked" : ""}" role="option" aria-selected="${m.id === current}" data-mail="${esc(m.id)}">
      <button type="button" class="mbx-check" data-mbx-check aria-label="Tick to add several" aria-pressed="${picked.has(k)}" title="Tick to add several">${icon("check")}</button>
      ${avatar(m.from, m.fromEmail || m.from)}
      <div class="mbx-row-main">
        <div class="mbx-row-top"><span class="mbx-from">${esc(m.from || "(unknown)")}</span>${m.attachment ? `<span class="mbx-clip" title="Has attachments">${icon("file")}</span>` : ""}<time>${esc(when(m.date))}</time></div>
        <div class="mbx-line">${BOOKING.test(m.subject) ? `<span class="mbx-pill">${icon("ticket")}Booking</span>` : ""}<span class="mbx-subj">${esc(m.subject)}</span><span class="mbx-snip"> – ${esc(m.snippet)}</span></div>
      </div></div>`;
  };
  const empty = (ic: IconName, title: string, text: string) => `<div class="mbx-empty">${icon(ic)}<b>${esc(title)}</b><span>${esc(text)}</span></div>`;
  /** The list as it's sorted (ties keep Gmail's order: newest first). */
  const shown = () => {
    const by: Record<string, (a: Mail, b: Mail) => number> = {
      old: (a, b) => a.date.localeCompare(b.date), unread: (a, b) => Number(b.unread) - Number(a.unread),
      bookings: (a, b) => Number(BOOKING.test(b.subject)) - Number(BOOKING.test(a.subject)), attach: (a, b) => Number(b.attachment) - Number(a.attachment),
      from: (a, b) => (a.from || a.fromEmail).localeCompare(b.from || b.fromEmail, undefined, { sensitivity: "base" }),
    };
    return by[sort] ? [...mails].sort(by[sort]) : mails;
  };
  const drawSort = () => { $d("[data-mbx-sort]").innerHTML = `${icon("sliders")}<span>${esc(SORTS.find(([s]) => s === sort)![1])}</span>${icon("chevronDown")}`; };
  const drawList = () => {
    drawSort();
    const q = input.value.trim();
    list.innerHTML = mails.length ? shown().map(row).join("") + (next ? `<div class="mbx-more" data-mbx-more>${loading ? "Loading more…" : "Scroll for more"}</div>` : `<div class="mbx-more">That's all</div>`)
      : q ? empty("search", "Nothing found", "Try other words, or Gmail's own: from:, subject:, has:attachment.")
      : view === "bookings" ? empty("ticket", "No booking emails found", "Search for the company or the place instead.")
      : empty("mail", "Nothing here", view === "files" ? "No emails with PDFs." : "The inbox is empty.");
    const more = list.querySelector("[data-mbx-more]");
    if (more) watcher.observe(more);
  };
  const watcher = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && next && !loading) load(next); }, { root: list, rootMargin: "200px" });

  // Only the newest request's answer is shown (another account, view or search meanwhile).
  let asked = 0, typing: number | undefined;
  const load = async (page = "") => {
    const mine = ++asked;
    loading = true;
    if (!page) { mails = []; next = ""; list.innerHTML = skeleton(8); list.scrollTop = 0; }
    else list.querySelector("[data-mbx-more]")?.replaceChildren("Loading more…");
    drawSide();
    try {
      const r = await api<{ mails: Mail[]; next: string }>(`/api/sync/gmail/list?${new URLSearchParams({ account, view, q: input.value.trim(), ...(page ? { page } : {}) })}`);
      if (mine !== asked) return;
      mails = [...mails, ...r.mails.filter((m) => !mails.some((x) => x.id === m.id))];
      next = r.next; loading = false;
      drawList();
    } catch (e) {
      if (mine !== asked) return;
      loading = false;
      list.innerHTML = empty("warn", "Couldn't load your mail", (e as Error).message);
    }
  };

  // ---- The right: the email ----
  const drawEmpty = () => {
    reader.innerHTML = empty("mail", "Pick an email to read it", "Add a booking confirmation to the chat, and it offers to put it into your trip.");
    main.classList.remove("reading");
  };
  const fetchMail = async (id: string, acc = account) => {
    const k = keyOf(id, acc);
    if (!opened.has(k)) opened.set(k, await api<Opened>(`/api/sync/gmail/message?${new URLSearchParams({ account: acc, id })}`));
    return opened.get(k)!;
  };
  let reading = 0;
  const open = async (id: string) => {
    const mine = ++reading;
    current = id;
    for (const r of list.querySelectorAll<HTMLElement>(".mbx-row")) { const on = r.dataset.mail === id; r.classList.toggle("on", on); r.setAttribute("aria-selected", String(on)); if (on) r.scrollIntoView({ block: "nearest" }); }
    main.classList.add("reading");
    const m0 = mails.find((x) => x.id === id);
    reader.innerHTML = `<div class="mbx-read-bar"><button type="button" class="icon-btn mbx-back" data-mbx-back aria-label="Back to the list">${icon("arrowLeft")}</button><span class="fill"></span></div>
      <div class="mbx-read-scroll"><h2 class="mbx-subject">${esc(m0?.subject || "")}</h2><div class="mbx-skel big" aria-hidden="true"><span class="mbx-av"></span><div><i></i><i></i></div></div><div class="mbx-paper loading"></div></div>`;
    try {
      const m = await fetchMail(id);
      if (mine !== reading) return;
      draw(m, id, false);
      // (Now it's been opened, it isn't shown as unread here; Gmail itself isn't told.)
    } catch (e) { if (mine === reading) reader.querySelector(".mbx-read-scroll")!.innerHTML = empty("warn", "Couldn't open this email", (e as Error).message); }
  };
  const draw = (m: Opened, id: string, images: boolean) => {
    const others = [...picked.keys()].filter((k) => k !== keyOf(id)).length;
    reader.innerHTML = `<div class="mbx-read-bar">
        <button type="button" class="icon-btn mbx-back" data-mbx-back aria-label="Back to the list">${icon("arrowLeft")}</button>
        <span class="fill"></span>
        <button type="button" class="btn" data-mbx-gmail title="Open this email in Gmail">Open in Gmail${ext()}</button>
        <button type="button" class="btn solid" data-mbx-add>${icon("plus")} ${others ? `Add with ${others} ticked` : "Add to chat"}</button>
      </div>
      <div class="mbx-read-scroll">${emailHtml(m, images)}</div>`;
    wireEmail(reader, m, images, () => draw(m, id, true));
    reader.querySelector<HTMLButtonElement>("[data-mbx-gmail]")!.onclick = () => openOutside(`https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${m.threadId}`);
    reader.querySelector<HTMLButtonElement>("[data-mbx-add]")!.onclick = () => add([keyOf(id), ...picked.keys()]);
  };

  // ---- Ticking several, and adding ----
  const drawPicked = () => {
    const box = $d(".mbx-picked");
    box.hidden = !picked.size;
    box.querySelector("b")!.textContent = `${picked.size} ticked`;
    const addBtn = reader.querySelector<HTMLButtonElement>("[data-mbx-add]");
    if (addBtn && current) { const others = [...picked.keys()].filter((k) => k !== keyOf(current)).length; addBtn.innerHTML = `${icon("plus")} ${others ? `Add with ${others} ticked` : "Add to chat"}`; }
  };
  const tick = (id: string) => {
    const k = keyOf(id), m = mails.find((x) => x.id === id);
    if (!m) return;
    if (picked.has(k)) picked.delete(k); else if (picked.size >= 4) { toast("At most 4 emails at once"); return; } else picked.set(k, { account, mail: m });
    const r = list.querySelector<HTMLElement>(`[data-mail="${CSS.escape(id)}"]`);
    r?.classList.toggle("picked", picked.has(k));
    r?.querySelector("[data-mbx-check]")?.setAttribute("aria-pressed", String(picked.has(k)));
    drawPicked();
  };
  const add = async (keys: string[]) => {
    const unique = [...new Set(keys)].slice(0, 4);
    for (const b of d.querySelectorAll<HTMLButtonElement>("[data-mbx-add], [data-mbx-add-picked]")) { b.disabled = true; b.textContent = "Adding…"; }
    try {
      const files = await Promise.all(unique.map(async (k) => {
        const [acc, id] = [k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1)];
        const m = await fetchMail(id, acc);
        return new File([bytesOf(m.data)], m.name, { type: "message/rfc822" });
      }));
      d.close();
      attach(files);
    } catch (e) {
      toast((e as Error).message);
      drawPicked();
      if (current) { const m = opened.get(keyOf(current)); if (m) draw(m, current, false); }
      const p = $d<HTMLButtonElement>("[data-mbx-add-picked]"); p.disabled = false; p.innerHTML = `${icon("plus")} Add to chat`;
    }
  };

  // ---- Wiring ----
  list.addEventListener("click", (e) => {
    const t = e.target as HTMLElement, r = t.closest<HTMLElement>("[data-mail]");
    if (!r) return;
    if (t.closest("[data-mbx-check]")) tick(r.dataset.mail!); else open(r.dataset.mail!);
  });
  reader.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("[data-mbx-back]")) main.classList.remove("reading"); });
  const accountBtn = $d<HTMLButtonElement>("[data-mbx-account-btn]");
  accountBtn.onclick = () => togglePopup(accountBtn, {
    className: "menu-pop mbx-acc-pop",
    html: all.map((a) => `<button type="button" role="menuitemradio" class="menu-item" aria-checked="${a.email === account}" data-mbx-account="${esc(a.email)}">${avatar(a.email, a.email)}<span><b>${esc(a.email)}</b>${a.expired ? "<small>Signed out: sign in again</small>" : ""}</span>${a.email === account ? icon("check") : ""}</button>`).join("")
      + `<button type="button" role="menuitem" class="menu-item" data-mbx-account="">${icon("plus")}<span><b>Add another account</b></span></button>`,
    pick: (b) => {
      const email = b.dataset.mbxAccount!;
      if (!email || !accounts.includes(email)) { addGmail(async () => { if (d.isConnected) { d.close(); openGmail(attach); } }); return; }
      if (email === account) return;
      account = email; current = ""; keep(); drawEmpty(); load();
    },
  });
  const side = $d(".mbx-side");
  side.addEventListener("click", (e) => {
    const t = e.target as HTMLElement, x = t.closest<HTMLElement>("[data-mbx-unfilter]"), f = t.closest<HTMLElement>("[data-mbx-filter]");
    if (x) { const gone = filters[+x.dataset.mbxUnfilter!]; filters = filters.filter((_, i) => i !== +x.dataset.mbxUnfilter!); keepFilters(); if (input.value.trim() === gone) drawSide(); else drawSide(); return; }
    if (f) searchFor(filters[+f.dataset.mbxFilter!]);
  });
  side.addEventListener("keydown", (e) => { const f = (e.target as HTMLElement).closest<HTMLElement>("[data-mbx-filter]"); if (f && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); searchFor(filters[+f.dataset.mbxFilter!]); } });
  $d<HTMLButtonElement>("[data-mbx-new-filter]").onclick = newFilter;
  const sortBtn = $d<HTMLButtonElement>("[data-mbx-sort]");
  sortBtn.onclick = () => togglePopup(sortBtn, {
    className: "menu-pop mbx-sort-pop", end: true,
    html: SORTS.map(([s, label, hint]) => `<button type="button" role="menuitemradio" class="menu-item" aria-checked="${s === sort}" data-sort="${s}"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ""}</span>${s === sort ? icon("check") : ""}</button>`).join(""),
    pick: (b) => { sort = b.dataset.sort!; keep(); const top = list.scrollTop; drawList(); list.scrollTop = top; },
  });
  $d<HTMLButtonElement>("[data-mbx-save]").onclick = () => { const q = input.value.trim(); if (q && !filters.includes(q)) { filters = [...filters, q.slice(0, 200)]; keepFilters(); drawSide(); } };
  for (const b of d.querySelectorAll<HTMLButtonElement>("[data-mbx-view]")) b.onclick = () => { view = b.dataset.mbxView!; input.value = ""; current = ""; keep(); drawEmpty(); load(); };
  $d<HTMLButtonElement>("[data-mbx-clear]").onclick = () => { picked.clear(); drawList(); drawPicked(); };
  $d<HTMLButtonElement>("[data-mbx-add-picked]").onclick = () => add([...picked.keys()]);
  // Searching as you type (a moment after the last key); Enter at once; Esc clears it first.
  input.addEventListener("input", () => { clearTimeout(typing); typing = window.setTimeout(() => searchFor(input.value), 450); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); searchFor(input.value); }
    if (e.key === "Escape" && input.value) { e.preventDefault(); e.stopPropagation(); searchFor(""); }
  });
  d.addEventListener("keydown", (e) => {
    const inField = (e.target as HTMLElement).matches("input, textarea, select");
    if (e.key === "/" && !inField) { e.preventDefault(); input.focus(); input.select(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (inField && e.key === "ArrowUp") return;
      e.preventDefault();
      const order = shown(), i = order.findIndex((m) => m.id === current), to = order[Math.max(0, Math.min(order.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (to && to.id !== current) { open(to.id); list.focus({ preventScroll: true }); }
      return;
    }
    if (inField || (e.target as HTMLElement).closest("button, a, [role=button], .menu-pop")) return;
    if (e.key === "x" && current) { e.preventDefault(); tick(current); }
    if (e.key === "Enter" && (current || picked.size)) { e.preventDefault(); add(current ? [keyOf(current), ...picked.keys()] : [...picked.keys()]); }
  });
  d.addEventListener("close", () => { watcher.disconnect(); d.remove(); });

  drawEmpty();
  drawSort();
  d.showModal();
  input.blur();
  list.focus({ preventScroll: true });
  load();
}
