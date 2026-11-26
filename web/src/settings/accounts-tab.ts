// Settings → Accounts: Google and Dropbox, each connected or not, what uses it, and signing in or out. Setting one up is
// the step-by-step window (connect-wizard.ts), also opened where a feature needs the account.
import type { SyncStatus } from "../../../shared/types";
import { api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { loadSyncStatus, setSyncStatus, syncStatus } from "../saves/sync-client";
import { askConfirm } from "../core/ask";
import { type Purpose, openConnect } from "./connect-wizard";

const use = (on: boolean, text: string, purpose: Purpose | "") => `<li class="acc-use${on ? " on" : ""}">${on ? icon("check") : `<span class="acc-off"></span>`}<span>${text}</span>${!on && purpose ? `<button type="button" class="link-btn" data-connect="${purpose}">Turn on</button>` : ""}</li>`;

function card(o: { id: "google" | "dropbox"; name: string; ico: Parameters<typeof icon>[0]; configured: boolean; signedIn: boolean; expired: boolean; who: string; email: string; uses: string; manage: string; error: string }) {
  const state = o.signedIn ? `<span class="dot ok"></span> Connected${o.who ? ` as ${esc(o.who)}` : ""}` : o.expired ? `<span class="dot warn"></span> ${o.name} signed this computer out` : `<span class="dot off"></span> Not connected`;
  return `<div class="set-card acc-card" data-account="${o.id}">
    <div class="set-row"><div><b>${icon(o.ico)} ${o.name}</b><div class="hint status">${state}${o.signedIn && o.email && o.email !== o.who ? ` · ${esc(o.email)}` : ""}</div></div>
      ${o.signedIn ? `<button type="button" class="btn" data-out="${o.id}">Sign out</button>`
        : `<button type="button" class="btn solid" data-connect="${o.id === "google" ? "drive" : "dropbox"}">${icon("key")} ${o.expired ? "Sign in again" : "Connect"}</button>`}</div>
    ${o.error ? `<p class="error-text">${icon("warn")} ${esc(o.error)}</p>` : ""}
    <ul class="acc-uses">${o.uses}</ul>
    ${o.configured ? `<details class="acc-manage"><summary>Your ${o.name} app</summary>${o.manage}</details>` : ""}
  </div>`;
}

function html(s: SyncStatus) {
  const g = card({
    id: "google", name: "Google", ico: "globe", configured: s.configured, signedIn: s.signedIn, expired: !!s.expired, who: s.name || s.email, email: s.email, error: s.signInError,
    uses: use(s.signedIn && s.drive !== false, "Sync trips through Drive folders", "drive")
      + use(s.signedIn && s.drive !== false, "Photos from your Drive on the map", "drive")
      + use(s.signedIn && !!s.cloud, "Gemini's exact limits", "quotas"),
    manage: `<p class="hint">${s.clientFrom === "env" ? "The client is set by environment variables." : "The ID and secret are saved on this computer. On another computer, paste the same two."} Client ID: <code>${esc(s.clientId)}</code></p>
      <div class="set-inline"><button type="button" class="btn" data-setup="drive" data-at="client">${icon("pencil")} Change or see the steps</button>
      ${s.clientFrom === "app" ? `<button type="button" class="btn" data-copy-client>${icon("copy")} Copy both</button><button type="button" class="btn" data-remove="google">Remove</button>` : ""}</div>`,
  });
  const d = s.dropbox;
  const box = card({
    id: "dropbox", name: "Dropbox", ico: "box", configured: !!d?.configured, signedIn: !!d?.signedIn, expired: !!d?.expired, who: d?.name || d?.email || "", email: d?.email || "", error: d?.signInError || "",
    uses: use(!!d?.signedIn, "Sync trips through Dropbox folders", "dropbox") + `<li class="acc-use na"><span class="acc-off"></span><span>Photos from Dropbox aren't supported</span></li>`,
    manage: `<p class="hint">${d?.keyFrom === "env" ? "The app key is set by the DROPBOX_APP_KEY environment variable." : "The app key is saved on this computer. On another computer, paste the same one."}</p>
      <div class="set-inline"><button type="button" class="btn" data-setup="dropbox" data-at="key">${icon("pencil")} Change or see the steps</button>
      ${d?.keyFrom === "app" ? `<button type="button" class="btn" data-remove="dropbox">Remove</button>` : ""}</div>`,
  });
  return `${g}${box}`;
}

export function renderAccounts(main: HTMLElement, again: () => void) {
  const s = syncStatus;
  const open = [...main.querySelectorAll<HTMLElement>("[data-account]")].filter((c) => c.querySelector<HTMLDetailsElement>("details")?.open).map((c) => c.dataset.account);
  main.innerHTML = `<h3>Accounts</h3>
    <p class="hint set-intro">Both are optional, and each uses your own free app there, so nobody shares anyone else's. Sign-ins stay on this computer.</p>
    ${s ? html(s) : `<p class="hint">Loading…</p>`}`;
  if (!s) { loadSyncStatus().then(again); return; }
  for (const id of open) { const el = main.querySelector<HTMLDetailsElement>(`[data-account="${id}"] details`); if (el) el.open = true; }
  const on = (sel: string, f: (b: HTMLButtonElement) => void) => main.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => { b.onclick = () => f(b); });
  const post = (url: string, body?: object) => api<SyncStatus>(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
  on("[data-connect]", (b) => { openConnect(b.dataset.connect as Purpose, again); });
  on("[data-setup]", (b) => { openConnect(b.dataset.setup as Purpose, again, b.dataset.at); });
  on("[data-copy-client]", async () => {
    const c = await api<{ id: string; secret: string }>("/api/sync/client");
    await navigator.clipboard.writeText(`${c.id}\n${c.secret}`);
    toast("Copied the client ID and secret");
  });
  on("[data-out]", async (b) => {
    const dbx = b.dataset.out === "dropbox", name = dbx ? "Dropbox" : "Google";
    if (!await askConfirm({ title: `Sign out of ${name}?`, text: `What uses ${name} stops until you sign in again. Nothing is deleted, here or at ${name}.`, ok: "Sign out" })) return;
    setSyncStatus(await post(dbx ? "/api/sync/dropbox/signout" : "/api/sync/signout")); again();
  });
  on("[data-remove]", async (b) => {
    const dbx = b.dataset.remove === "dropbox";
    if (!await askConfirm({ title: dbx ? "Remove your Dropbox app key?" : "Remove your Google client?", text: "It's deleted from this computer and you're signed out. Nothing else is deleted.", ok: "Remove", danger: true })) return;
    setSyncStatus(await post(dbx ? "/api/sync/dropbox/key" : "/api/sync/client/remove", dbx ? { key: "" } : undefined)); again();
  });
}
