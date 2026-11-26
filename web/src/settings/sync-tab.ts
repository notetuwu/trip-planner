// Settings → Sync: the folders trips sync with (in Google Drive, Dropbox or on this computer; your own, or ones friends
// shared with you). The accounts are set up in Settings → Accounts or with the Connect buttons here (connect-wizard.ts).
// Which trips go where is chosen per trip in Your trips.
import type { SyncFolder, SyncStatus } from "../../../shared/types";
import { $$, api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { type Purpose, openConnect } from "./connect-wizard";
import { loadSyncStatus, setSyncStatus, syncStatus } from "../saves/sync-client";
import { classifyLink, pickFolder } from "../core/folder-picker";
import { askConfirm, askText, tell } from "../core/ask";

/** Draws the tab into `main`; `again` redraws it (after a change). */
export function renderSync(main: HTMLElement, again: () => void) {
  const s = syncStatus;
  main.innerHTML = syncHtml(s);
  wire(main, again);
  if (!s) loadSyncStatus().then(again);
}

export function syncHtml(s: SyncStatus | null) {
  const intro = `<h3>Sync</h3>
    <p class="hint set-intro">Keep trips in step between your computers and with other people, through shared folders: in Google Drive or Dropbox, or on this computer (a network drive, or a folder OneDrive, Dropbox or iCloud keeps in step). Pick per trip which folders it goes to (Your trips → ${icon("cloud")} on a trip).</p>`;
  if (!s) return `${intro}<p class="hint">Loading…</p>`;
  const folders = `
    <div class="set-card">
      <b class="card-title">${icon("folder")} Sync folders</b>
      ${s.folders.length ? `<div class="sync-folder-list">${s.folders.map(folderRow).join("")}</div>` : `<p class="hint">None yet. Add a folder: one in your Google Drive, one a friend shared with you, or one on this computer.</p>`}
      <div class="drive-add">
        <button type="button" class="drive-tile" id="syncBrowse"><span class="dt-ic">${icon("plus")}</span><span class="dt-text"><b>Add a folder</b><span>From this computer, Google Drive or Dropbox, or make a new one</span></span></button>
        <button type="button" class="link-btn drive-paste-btn" id="syncPaste">${icon("link")} Or paste a link or path</button>
      </div>
      ${s.lastRun || s.running ? `<div class="set-row"><div><div class="hint">${s.running ? "Syncing…" : `Last synced ${esc(new Date(s.lastRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}`}</div>${s.error ? `<p class="error-text">${icon("warn")} ${esc(s.error)}</p>` : ""}</div>
        <button type="button" class="btn" id="syncNow">${icon("refresh")} Sync now</button></div>` : ""}
    </div>`;
  const where = (name: string, ico: Parameters<typeof icon>[0], purpose: Purpose, on: boolean, who: string) => `<div class="set-row"><div><b>${icon(ico)} ${name}</b>
      <div class="hint">${on ? `Connected${who ? ` as ${esc(who)}` : ""}: its folders can be added.` : "Not connected. Connect it to add its folders."}</div></div>
    ${on ? `<button type="button" class="link-btn" data-to-tab="accounts">Manage</button>` : `<button type="button" class="btn" data-connect="${purpose}">Connect</button>`}</div>`;
  const accounts = `<div class="set-card"><b class="card-title">${icon("key")} Where folders can be</b>
    <div class="set-row"><div><b>${icon("monitor")} This computer</b><div class="hint">Ready. A network drive, or a folder OneDrive, Dropbox or iCloud keeps in step.</div></div></div>
    ${where("Google Drive", "drive", "drive", s.signedIn && s.drive !== false, s.name || s.email)}
    ${where("Dropbox", "box", "dropbox", !!s.dropbox?.signedIn, s.dropbox?.name || s.dropbox?.email || "")}</div>`;
  return `${intro}${folders}${accounts}
    <div class="set-card">
      <b class="card-title">Good to know</b>
      <ul class="set-list">
        <li>Every save of a synced trip goes to its folders a few seconds later, and the app looks for changes from others every few minutes (and when you open Your trips). Without internet, changes wait and go when it's back.</li>
        <li>Changed here and somewhere else since the last sync? Changes to different things are joined; only when both changed the same thing does Your trips ask which version to keep, and the other one stays in Recover….</li>
        <li>Per trip, the person who shares it decides whether others can <b>edit</b> it or only <b>view</b> it.</li>
        <li>Nothing is ever deleted in a sync folder. Deleting a trip here, unticking a folder or removing a folder below only stops syncing there.</li>
        <li>A folder on this computer can be a network drive or a folder a cloud app keeps in step (OneDrive, iCloud Drive, or Dropbox's app): the trips go wherever that folder goes.</li>
        <li>Your Google sign-in stays on this computer. It's never in a trip, a folder or on a phone. Photo folders on this computer and the prompts sent to the AI aren't shared either.</li>
        <li>For Drive the app may use your whole Drive (Google has no narrower permission for shared folders), but it only opens the folders listed here. To remove its access completely: sign out, or remove your app at myaccount.google.com → Security → Third-party connections.</li>
      </ul>
    </div>`;
}

function folderRow(f: SyncFolder) {
  const local = f.id.startsWith("local:"), dbx = f.id.startsWith("dropbox:");
  const where = local ? `${f.kind ? `${f.kind} · ` : ""}${f.id.slice(6)}` : `“${f.name}” in ${dbx ? "Dropbox" : "Google Drive"}`;
  return `<div class="set-row sync-folder-row" data-id="${esc(f.id)}"><div><b>${icon(local ? "monitor" : dbx ? "box" : "drive")} ${esc(f.label)}</b>
      <div class="hint" title="${esc(where)}">${esc(where)} · ${f.canWrite ? "you can add trips" : "you can only open its trips, not add or change them"}</div>
      ${f.error ? `<div class="error-text">${icon("warn")} ${esc(f.error)}</div>` : ""}</div>
    <span class="set-inline">${local || dbx ? "" : `<a class="icon-btn" href="https://drive.google.com/drive/folders/${encodeURIComponent(f.id)}" target="_blank" rel="noopener" title="Open in Drive">${icon("external")}</a>`}
      <button type="button" class="icon-btn" data-rename title="Rename">${icon("pencil")}</button><button type="button" class="icon-btn" data-remove title="Stop syncing with this folder">${icon("trash")}</button></span></div>`;
}

function wire(main: HTMLElement, again: () => void) {
  const post = async (url: string, body?: object) => api(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
  $$<HTMLButtonElement>("[data-connect]", main).forEach((b) => { b.onclick = () => openConnect(b.dataset.connect as Purpose, again); });
  main.querySelector<HTMLButtonElement>("#syncNow")?.addEventListener("click", async (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    setSyncStatus(await post("/api/sync/now").catch((err) => { toast((err as Error).message); return syncStatus; })); again();
  });
  const add = async (link: string, label = "") => {
    // A folder on this computer that nothing carries elsewhere: only a second copy. Said before it's added.
    const local = classifyLink(link);
    if (local.kind === "local") {
      const k = await api<{ shared: boolean }>(`/api/sync/kind?path=${encodeURIComponent(local.path)}`).catch(() => null);
      if (k && !k.shared && !await askConfirm({ title: "This folder is only on this computer", text: "Trips synced to it are a second copy on this PC: nobody else sees them, and your other computers don't either.\n\nTo share trips, choose a folder inside OneDrive, Dropbox or iCloud Drive (their apps carry it to your other computers and to people you share it with), on a network drive, or in Google Drive.", ok: "Add it anyway", cancel: "Choose another" })) return;
    }
    try { const r = await post("/api/sync/folders", { link, label }); setSyncStatus(r.status); toast(`Added “${r.folder.label}”`); }
    catch (err) { toast((err as Error).message); }
    again();
  };
  main.querySelector<HTMLButtonElement>("#syncBrowse")?.addEventListener("click", async () => {
    const f = await pickFolder({ title: "Choose a folder to sync trips with", note: "Trips you sync to it are saved there, and trips others put there show in Your trips. Who else can use it is up to where it is (sharing in Drive, a network drive's permissions…)." });
    if (f) add(f.link, f.name);
  });
  main.querySelector<HTMLButtonElement>("#syncPaste")?.addEventListener("click", async () => {
    const text = await askText({ title: "Paste a link or path", text: "A Google Drive or Dropbox folder's link (Share → Copy link), or a folder's path on this computer or a network drive.", placeholder: "https://drive.google.com/drive/folders/…  or  C:\\…", ok: "Add", required: true });
    if (!text) return;
    const c = classifyLink(text);
    if (c.kind === "cloud") return void tell({ title: `${c.name} links can't be opened here yet`, text: `If the ${c.name} app keeps the folder on this computer, add it from there: Add a folder → This computer.` });
    if (c.kind === "unknown") return void toast("That isn't a Google Drive link or a folder's path.");
    add(text);
  });
  for (const row of $$<HTMLElement>(".sync-folder-row", main)) {
    const id = row.dataset.id!, f = syncStatus?.folders.find((x) => x.id === id);
    row.querySelector<HTMLButtonElement>("[data-rename]")!.onclick = async () => {
      const label = await askText({ title: "Rename folder", text: "Its name in the app (in Drive it stays as it is).", value: f?.label || "", ok: "Rename", required: true });
      if (!label) return;
      setSyncStatus(await post("/api/sync/folders/rename", { id, label })); again();
    };
    row.querySelector<HTMLButtonElement>("[data-remove]")!.onclick = async () => {
      if (!await askConfirm({ title: `Stop syncing with “${f?.label}”?`, text: "Its trips stay in the folder in Drive, and the copies on this computer stay too: they just stop syncing there.", ok: "Stop syncing", danger: true })) return;
      setSyncStatus(await post("/api/sync/folders/remove", { id })); again();
    };
  }
}
