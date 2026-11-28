// Booking confirmations attached in the trip chat: the files are held while the page is open, and a card under the
// answer asks whether to keep them in a "docs" folder next to the trip (server/routes/docs.ts). Kept ones are linked
// from the bookings the chat made of them.
import { api, apiUrl, esc, toast } from "../core/dom";
import { showEmail } from "./email-view";
import { icon } from "../core/icons";
import { state } from "../core/state";

/** The files besides pictures that the chat can read. */
export const ATTACHABLE = /\.(pdf|eml|txt|html?|ics|csv|md|json)$/i;

/** The attached files that can be kept in the docs folder (a .json there would look like a trip to sync). */
export const keepable = (name: string) => !/\.json$/i.test(name);

/** The card under an answer: the files offered, where they went, or that they weren't wanted. */
export interface ChatDocs { key: string; names: string[]; kept?: string[]; place?: string; declined?: boolean }
interface Turn { docs?: ChatDocs; change?: { status?: string; edits?: { op: string; [k: string]: unknown }[] } }
interface Place { id: string; label: string; shared: boolean }

const held = new Map<string, File[]>();
export function holdFiles(files: File[]) {
  const key = Math.random().toString(36).slice(2, 10);
  held.set(key, files);
  return key;
}
export const heldFiles = (key?: string) => (key ? held.get(key) || [] : []);

/** Files as the server takes them: name and base64. */
export const filesData = (files: File[]) => Promise.all(files.map((f) => new Promise<{ name: string; data: string }>((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok({ name: f.name, data: String(r.result).split(",")[1] || "" });
  r.onerror = () => fail(new Error(`Couldn't read ${f.name}.`));
  r.readAsDataURL(f);
})));

export const docUrl = (name: string) => apiUrl(`/api/docs/file?${new URLSearchParams({ trip: state.saveName || "", file: name })}`);

// A kept email (in the chat's card, or on a booking in the sidebar) opens to read, not as a download.
document.addEventListener("click", async (e) => {
  const a = (e.target as HTMLElement | null)?.closest?.<HTMLAnchorElement>("a.cp-file[href*='/api/docs/file']");
  if (!a || !/\.eml$/i.test(new URL(a.href).searchParams.get("file") || "")) return;
  e.preventDefault();
  try {
    const r = await fetch(a.href);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    showEmail(new File([await r.blob()], new URL(a.href).searchParams.get("file")!));
  } catch (err) { toast(`Couldn't open it: ${(err as Error).message}`); }
});

/** Links the kept files from the bookings that turn's change added (once it's applied). */
export function linkDocs(turn: Turn | undefined) {
  const kept = turn?.docs?.kept;
  if (!kept?.length || turn!.change?.status !== "applied" && turn!.change?.status !== "applying") return;
  for (const e of turn!.change!.edits || []) {
    if (e.op !== "addBooking") continue;
    const b = [...(state.bookings || [])].reverse().find((x) => x.name === String(e.name) && x.date === String(e.date));
    if (b) b.docs = [...new Set([...(b.docs || []), ...kept])];
  }
}

/** Where this trip's files can go, once asked (by save name), and what went wrong last. */
const places = new Map<string, Place[] | "asking">();
const errors = new Map<string, string>();
let busy = "";

export function docsCard(d: ChatDocs, k: number) {
  const what = d.names.length > 1 ? `these ${d.names.length} files` : "this file";
  const box = (body: string) => `<div class="cp-docs">${body}</div>`;
  if (d.kept) {
    return box(`<span class="ok-text">${icon("check")} Kept in the docs folder (${esc(d.place || "")})</span><div class="cp-docs-act">${d.kept.map((n) => `<a class="cp-file" href="${esc(docUrl(n))}" target="_blank" rel="noopener">${icon("file")}<span>${esc(n)}</span></a>`).join("")}</div>`);
  }
  if (d.declined) return box(`<span class="hint">The file${d.names.length > 1 ? "s weren't" : " wasn't"} kept.</span>`);
  if (!heldFiles(d.key).length) return box(`<span class="hint">To keep ${what} with the trip, attach ${d.names.length > 1 ? "them" : "it"} again (the page was reloaded).</span>`);
  const no = `<button type="button" class="link-btn" data-docs-no="${k}">Don't keep</button>`;
  if (!state.saveName) return box(`<b>Keep ${what} with the trip?</b><span class="hint">Save the trip first (Save, in the sidebar): the files go into a docs folder next to it.</span><div class="cp-docs-act"><button type="button" class="btn" data-docs-check="${k}">I've saved it</button>${no}</div>`);
  const list = places.get(state.saveName);
  if (!list || list === "asking") return box(`<span class="hint">${esc(errors.get(d.key) || "Looking where the files can go…")}</span><div class="cp-docs-act">${errors.has(d.key) ? `<button type="button" class="btn" data-docs-check="${k}">Try again</button>` : ""}${no}</div>`);
  const shared = list.some((p) => p.shared);
  return box(`<b>Keep ${what} in a docs folder next to the trip?</b>
    ${shared ? `<span class="hint">Everyone the folder is shared with can open ${d.names.length > 1 ? "them" : "it"}.</span>` : ""}
    ${errors.has(d.key) ? `<span class="hint">${esc(errors.get(d.key)!)}</span>` : ""}
    <div class="cp-docs-act">${busy === d.key ? `<span class="hint">Saving…</span>` : `${list.map((p) => `<button type="button" class="btn" data-docs-keep="${k}" data-place="${esc(p.id)}">${icon("folder")} ${esc(p.label)}</button>`).join("")}${no}`}</div>`);
}

/** The card's buttons; `redraw` after anything changed (saving the trip too, when files were kept). */
export function wireDocs(log: HTMLElement, turn: (k: number) => Turn | undefined, redraw: () => void) {
  const name = state.saveName;
  // Asked once per trip, when a card first needs it.
  if (name && !places.has(name) && log.querySelector(".cp-docs [data-docs-no]")) {
    places.set(name, "asking");
    api<{ places: Place[] }>(`/api/docs?${new URLSearchParams({ trip: name })}`).then((r) => { places.set(name, r.places); redraw(); })
      .catch((e: Error) => {
        for (const b of log.querySelectorAll<HTMLElement>("[data-docs-no]")) { const d = turn(+b.dataset.docsNo!)?.docs; if (d) errors.set(d.key, `Couldn't look: ${e.message}`); }
        redraw();
      });
  }
  const on = (attr: string, run: (t: Turn & { docs: ChatDocs }, b: HTMLElement) => void) => {
    for (const b of log.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`)) b.onclick = () => { const t = turn(Number(b.getAttribute(`data-${attr}`))); if (t?.docs) run(t as Turn & { docs: ChatDocs }, b); };
  };
  on("docs-no", (t) => { t.docs.declined = true; redraw(); });
  on("docs-check", (t) => { places.delete(state.saveName || ""); errors.delete(t.docs.key); redraw(); });
  on("docs-keep", async (t, b) => {
    const d = t.docs, place = b.dataset.place!, label = b.textContent!.trim();
    busy = d.key; errors.delete(d.key); redraw();
    try {
      const { names } = await api<{ names: string[] }>("/api/docs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trip: state.saveName, place, files: await filesData(heldFiles(d.key).filter((f) => keepable(f.name))) }) });
      d.kept = names; d.place = label;
      linkDocs(t);
    } catch (e) { errors.set(d.key, `Couldn't keep ${d.names.length > 1 ? "them" : "it"}: ${(e as Error).message}`); places.delete(state.saveName || ""); }
    busy = "";
    redraw();
  });
}
