// Settings → Sync: sign in with Google, and the Drive folders trips sync with (your own, or ones friends shared with you).
// Which trips go where is chosen per trip in Your trips.
import type { SyncFolder, SyncStatus } from "../../../shared/types";
import { $$, api, esc, toast } from "../core/dom";
import { ext, icon } from "../core/icons";
import { loadSyncStatus, setSyncStatus, syncStatus } from "../saves/sync-client";

let watching: number | undefined;
/** The setup guide is open (kept while the tab redraws). */
let guideOpen = false;

const link = (url: string, text: string) => `<a href="${url}" target="_blank" rel="noopener">${text}${ext()}</a>`;
const copyable = (text: string) => `<span class="link-row"><code>${esc(text)}</code><button type="button" class="icon-btn" data-copy="${esc(text)}" title="Copy">${icon("copy")}</button></span>`;

/** Getting a client ID and secret from Google, step by step (the same as docs/google-sync.md). */
const GUIDE = () => `<ol class="set-steps sync-guide">
  <li><b>Open the Google Cloud Console</b> and pick a project at the top. The one with your Google API key is fine; otherwise make one (<i>New project</i>, any name, e.g. “Trip Planner”). It's free and needs no payment details.<br>${link("https://console.cloud.google.com/", "Google Cloud Console")}</li>
  <li><b>Switch on the Drive API:</b> press <i>Enable</i>. (If it says <i>Manage</i>, it's already on, e.g. for photos.)<br>${link("https://console.cloud.google.com/apis/library/drive.googleapis.com", "Google Drive API")}</li>
  <li><b>Describe the app:</b> press <i>Get started</i> (not shown if the project already has a sign-in screen). App name “Trip Planner”, support email: yours. Audience: <i>External</i>. Contact email: yours. Agree and press <i>Create</i>.<br>${link("https://console.cloud.google.com/auth/branding", "Google Auth Platform → Branding")}
    <br>Then on <i>Branding</i>, under <i>App domain</i>, fill in these two (without them <i>Publish app</i> sends you back here; <i>Terms of service</i> can stay empty) and press <i>Save</i>.
    <br><i>Application home page:</i> ${copyable("https://github.com/notetuwu/trip-planner")}<i>Privacy policy link:</i> ${copyable("https://github.com/notetuwu/trip-planner/blob/main/PRIVACY.md")}Under <i>Authorized domains</i> add: ${copyable("github.com")}</li>
  <li><b>Publish it:</b> under <i>Audience</i>, press <i>Publish app</i> and confirm, so it says <i>In production</i>. Left in <i>Testing</i>, Google signs you out every 7 days. Don't send it for verification (a message about it can be ignored).<br>${link("https://console.cloud.google.com/auth/audience", "Audience")}
    <br>Then under <i>Data access</i> → <i>Add or remove scopes</i>, paste this into <i>Manually add scopes</i>, press <i>Add to table</i>, <i>Update</i>, then <i>Save</i>: ${copyable("https://www.googleapis.com/auth/drive")}${link("https://console.cloud.google.com/auth/scopes", "Data access")}</li>
  <li><b>Create the client:</b> under <i>Clients</i>, press <i>Create client</i>. Application type: <b>Desktop app</b>. Press <i>Create</i>. <b>Copy the Client ID and Client secret now</b> (or download the JSON): Google shows the secret only this once. Lost it? Make a new client.<br>${link("https://console.cloud.google.com/auth/clients", "Clients")}</li>
  <li><b>Paste both below</b> and press <i>Save</i>, then <i>Sign in with Google</i>.</li>
  <li><b>Google's warning:</b> “Google hasn't verified this app” appears because it's your own private app. Press <i>Advanced</i> → <i>Go to Trip Planner (unsafe)</i>, tick the Drive box and continue.<br>“<b>Access blocked</b>: … has not completed the Google verification process” instead? The app is still in <i>Testing</i>: do step 4 (<i>Publish app</i>), then sign in again.</li>
</ol>
<p class="hint">On your other computers, paste the same ID and secret; steps 1–5 are only needed once. Friends make their own the same way (or you give them yours: then they count towards your project's limit of 100 users, and see your support email when signing in). Different IDs can sync through the same shared folder.</p>`;

function clientCard(s: SyncStatus) {
  const fields = `<div class="sync-add"><input id="syncClientId" type="text" placeholder="Client ID (…apps.googleusercontent.com), or the downloaded JSON" autocomplete="off" spellcheck="false"><input id="syncClientSecret" type="password" placeholder="Client secret (GOCSPX-…)" autocomplete="off"><button type="button" class="btn solid" id="syncClientSave">${icon("check")} Save</button></div>`;
  const guide = `<details class="sync-guide-box" id="syncGuide"${guideOpen ? " open" : ""}><summary>${s.configured ? "How to get a client ID and secret" : "Step-by-step: get your client ID and secret (about 5–10 minutes, once)"}</summary>${GUIDE()}</details>`;
  if (!s.configured) return `<div class="set-card">
    <div class="set-row"><div><b>Your Google client</b><div class="hint">Syncing signs in with your own free Google “client” (an ID and a secret), so nobody shares anyone else's. It's not the same as an API key, but comes from the same place. Both stay on this computer.</div></div></div>
    ${guide}${fields}</div>`;
  return `<div class="set-card">
    <div class="set-row"><div><b>Your Google client</b><div class="hint">${s.clientFrom === "env" ? "From the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables." : "Saved on this computer."} ID: …${esc(s.clientId.replace(/\.apps\.googleusercontent\.com$/, "").slice(-8))}</div></div>
      ${s.clientFrom === "app" ? `<span class="set-inline"><button type="button" class="btn" id="syncClientCopy">${icon("copy")} Copy ID</button><button type="button" class="btn" id="syncClientRemove">Remove</button></span>` : ""}</div>
    ${guide}</div>`;
}

/** Draws the tab into `main`; `again` redraws it (after a change). */
export function renderSync(main: HTMLElement, again: () => void) {
  const s = syncStatus;
  main.innerHTML = syncHtml(s);
  wire(main, again);
  if (!s) loadSyncStatus().then(again);
}

export function syncHtml(s: SyncStatus | null) {
  const intro = `<h3>Sync</h3>
    <p class="hint set-intro">Keep trips in step between your computers and with other people, through folders in your Google Drive. Pick per trip which folders it goes to (Your trips → ${icon("cloud")} on a trip). Who can see a folder is set in Drive, by sharing it.</p>`;
  if (!s) return `${intro}<p class="hint">Loading…</p>`;
  if (!s.configured) return `${intro}${clientCard(s)}`;
  const account = s.signedIn
    ? `<div class="set-row"><div><b class="status"><span class="dot ok"></span> Signed in as ${esc(s.name || s.email)}</b><div class="hint">${esc(s.email)}${s.lastRun ? ` · last synced ${esc(new Date(s.lastRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}` : ""}${s.running ? " · syncing…" : ""}</div></div>
        <span class="set-inline"><button type="button" class="btn" id="syncNow">${icon("refresh")} Sync now</button><button type="button" class="btn" id="syncOut">Sign out</button></span></div>
       ${s.error ? `<p class="error-text">${icon("warn")} ${esc(s.error)}</p>` : ""}`
    : `<div class="set-row"><div><b class="status"><span class="dot ${s.expired ? "warn" : "off"}"></span> ${s.expired ? "Google signed this computer out" : "Not signed in"}</b>
        <div class="hint">${s.signingIn ? "Finish signing in in your browser (the page Google opened). Closed it, or Google showed an error? Open it again." : "Your browser opens Google's sign-in page. Google warns that the app isn't verified: press <i>Advanced</i>, then <i>Go to … (unsafe)</i>, and allow Drive access (the app needs it to see trips other people put in shared folders)."}</div></div>
        <button type="button" class="btn solid" id="syncIn">${icon("key")} ${s.signingIn ? "Open Google again" : "Sign in with Google"}</button></div>
       ${s.signInError ? `<p class="error-text">${icon("warn")} ${esc(s.signInError)}</p>` : ""}`;
  const folders = !s.signedIn ? "" : `
    <div class="set-card">
      <b class="card-title">${icon("folder")} Sync folders</b>
      ${s.folders.length ? `<div class="sync-folder-list">${s.folders.map(folderRow).join("")}</div>` : `<p class="hint">None yet. Add one of your folders (or one a friend shared with you), or make a new one.</p>`}
      <div class="set-row"><div><b>Add a folder</b><div class="hint">Open the folder in Drive, press Share → Copy link, and paste it here. A name for it in the app helps (“Friends”, “Us two”).</div></div></div>
      <div class="sync-add"><input id="syncLink" type="url" placeholder="https://drive.google.com/drive/folders/…" autocomplete="off"><input id="syncLabel" type="text" placeholder="Name (optional)" maxlength="60"><button type="button" class="btn solid" id="syncAdd">${icon("plus")} Add</button></div>
      <button type="button" class="link-btn" id="syncCreate">${icon("plus")} Make a new folder in my Drive</button>
    </div>`;
  return `${intro}<div class="set-card">${account}</div>${folders}${clientCard(s)}
    <div class="set-card">
      <b class="card-title">Good to know</b>
      <ul class="set-list">
        <li>Every save of a synced trip goes to its folders a few seconds later, and the app looks for changes from others every few minutes (and when you open Your trips). Without internet, changes wait and go when it's back.</li>
        <li>Changed here and somewhere else since the last sync? Nothing is overwritten: Your trips asks which version to keep, and the other one stays in Recover….</li>
        <li>Per trip, the person who shares it decides whether others can <b>edit</b> it or only <b>view</b> it.</li>
        <li>Nothing is ever deleted in Drive. Deleting a trip here, unticking a folder or removing a folder below only stops syncing there.</li>
        <li>Your Google sign-in stays on this computer. It's never in a trip, a folder or on a phone. Photo folders on this computer and the prompts sent to the AI aren't shared either.</li>
        <li>The app may use your whole Drive (Google has no narrower permission for shared folders), but it only opens the folders listed here. To remove its access completely: sign out, or remove your app at myaccount.google.com → Security → Third-party connections.</li>
      </ul>
    </div>`;
}

function folderRow(f: SyncFolder) {
  return `<div class="set-row sync-folder-row" data-id="${esc(f.id)}"><div><b>${esc(f.label)}</b>
      <div class="hint">${f.name && f.name !== f.label ? `“${esc(f.name)}” in Drive · ` : ""}${f.canWrite ? "you can add trips" : "you can only view this folder (open its trips, not add or change them)"}</div>
      ${f.error ? `<div class="error-text">${icon("warn")} ${esc(f.error)}</div>` : ""}</div>
    <span class="set-inline"><a class="icon-btn" href="https://drive.google.com/drive/folders/${encodeURIComponent(f.id)}" target="_blank" rel="noopener" title="Open in Drive">${icon("external")}</a>
      <button type="button" class="icon-btn" data-rename title="Rename">${icon("pencil")}</button><button type="button" class="icon-btn" data-remove title="Stop syncing with this folder">${icon("trash")}</button></span></div>`;
}

/** While Google's page is open in the browser: look every 2 seconds whether signing in is done. */
function watchSignIn(again: () => void) {
  clearInterval(watching);
  const until = Date.now() + 11 * 60_000;
  watching = window.setInterval(async () => {
    const s = await loadSyncStatus();
    if (!s?.signingIn || Date.now() > until) {
      clearInterval(watching);
      if (s?.signedIn) toast(`Signed in as ${s.email}`);
    }
    if (document.querySelector("#syncIn, #syncOut")) again();
  }, 2000);
}

function wire(main: HTMLElement, again: () => void) {
  const post = async (url: string, body?: object) => api(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
  main.querySelector<HTMLDetailsElement>("#syncGuide")?.addEventListener("toggle", (e) => { guideOpen = (e.target as HTMLDetailsElement).open; });
  $$<HTMLButtonElement>("[data-copy]", main).forEach((b) => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy!).then(() => toast("Copied")); });
  main.querySelector<HTMLButtonElement>("#syncClientSave")?.addEventListener("click", async () => {
    const id = main.querySelector<HTMLInputElement>("#syncClientId")!.value, secret = main.querySelector<HTMLInputElement>("#syncClientSecret")!.value;
    try { setSyncStatus(await post("/api/sync/client", { id, secret })); guideOpen = false; toast("Saved. Now sign in with Google."); again(); }
    catch (e) { toast((e as Error).message); }
  });
  main.querySelector<HTMLButtonElement>("#syncClientCopy")?.addEventListener("click", () => navigator.clipboard.writeText(syncStatus?.clientId || "").then(() => toast("Copied the client ID")));
  main.querySelector<HTMLButtonElement>("#syncClientRemove")?.addEventListener("click", async () => {
    if (!confirm("Remove the client ID and secret from this computer? You'll be signed out and trips stop syncing; nothing is deleted, here or in Drive.")) return;
    setSyncStatus(await post("/api/sync/client/remove")); again();
  });
  main.querySelector<HTMLButtonElement>("#syncIn")?.addEventListener("click", async () => {
    try { await post("/api/sync/signin"); await loadSyncStatus(); again(); watchSignIn(again); }
    catch (e) { toast((e as Error).message); }
  });
  main.querySelector<HTMLButtonElement>("#syncOut")?.addEventListener("click", async () => {
    if (!confirm("Sign out of Google? Trips stop syncing until you sign in again; nothing is deleted, here or in Drive.")) return;
    setSyncStatus(await post("/api/sync/signout")); again();
  });
  main.querySelector<HTMLButtonElement>("#syncNow")?.addEventListener("click", async (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    setSyncStatus(await post("/api/sync/now").catch((err) => { toast((err as Error).message); return syncStatus; })); again();
  });
  main.querySelector<HTMLButtonElement>("#syncAdd")?.addEventListener("click", async (e) => {
    const link = main.querySelector<HTMLInputElement>("#syncLink")!.value.trim(), label = main.querySelector<HTMLInputElement>("#syncLabel")!.value.trim();
    if (!link) return toast("Paste the folder's link first");
    (e.currentTarget as HTMLButtonElement).disabled = true;
    try { const r = await post("/api/sync/folders", { link, label }); setSyncStatus(r.status); toast(`Added “${r.folder.label}”`); }
    catch (err) { toast((err as Error).message); }
    again();
  });
  main.querySelector<HTMLButtonElement>("#syncCreate")?.addEventListener("click", async () => {
    const name = prompt("Name of the new folder in your Drive:", "Trip Planner trips")?.trim();
    if (!name) return;
    try { const r = await post("/api/sync/folders", { create: true, name, label: name }); setSyncStatus(r.status); toast(`Made “${r.folder.name}” in your Drive. Share it there to sync trips with others.`); }
    catch (err) { toast((err as Error).message); }
    again();
  });
  for (const row of $$<HTMLElement>(".sync-folder-row", main)) {
    const id = row.dataset.id!, f = syncStatus?.folders.find((x) => x.id === id);
    row.querySelector<HTMLButtonElement>("[data-rename]")!.onclick = async () => {
      const label = prompt("Name in the app:", f?.label || "")?.trim();
      if (!label) return;
      setSyncStatus(await post("/api/sync/folders/rename", { id, label })); again();
    };
    row.querySelector<HTMLButtonElement>("[data-remove]")!.onclick = async () => {
      if (!confirm(`Stop syncing with “${f?.label}”? Its trips stay in the folder in Drive, and the copies on this computer stay too (they just stop syncing there).`)) return;
      setSyncStatus(await post("/api/sync/folders/remove", { id })); again();
    };
  }
}
