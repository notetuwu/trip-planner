// DOM and server helpers used everywhere.

/** When the page is opened straight from disk, talk to the local server instead. */
const API_BASE = location.protocol === "file:" ? "http://localhost:5173" : "";

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

/** Escapes text for use inside HTML strings. */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** JSON request to the planner's server; throws with the server's error message. */
export async function api<T = any>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(API_BASE + url, { ...opts, headers: { "Content-Type": "application/json", ...opts.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/** The address of a server route for an <img> or a link (the page can be open straight from disk). */
export const apiUrl = (url: string) => API_BASE + url;

/** The raw fetch, for streamed responses. */
export const apiFetch = (url: string, opts: RequestInit) => fetch(API_BASE + url, opts);

let toastTimer: number | undefined;
/** A short message at the bottom of the screen, optionally with an Undo button. */
export function toast(msg: string, undo?: () => void) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button>Undo</button>` : ""}`;
  el.hidden = false;
  if (undo) el.querySelector("button")!.onclick = () => { el.hidden = true; undo(); };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, undo ? 8000 : 4000);
}

/** Saves a file to the user's downloads. */
export function downloadFile(file: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
}

/** Clicking the dimmed area around a modal closes it (only a click that also started there, not a text selection dragged out). */
export function closeOnBackdrop(d: HTMLDialogElement) {
  const outside = (e: MouseEvent) => {
    const r = d.getBoundingClientRect();
    return e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  let downOutside = false;
  d.addEventListener("mousedown", (e) => { downOutside = outside(e); });
  d.addEventListener("click", (e) => { if (downOutside && outside(e)) d.close(); downOutside = false; });
}
