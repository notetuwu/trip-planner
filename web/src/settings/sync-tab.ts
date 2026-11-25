// Settings → Sync: sign in with Google, and the Drive folders trips sync with (your own, or ones friends shared with you).
// Which trips go where is chosen per trip in Your trips.
import type { SyncFolder, SyncStatus } from "../../../shared/types";
import { $$, api, esc, toast } from "../core/dom";
import { ext, icon } from "../core/icons";
import { loadSyncStatus, setSyncStatus, syncStatus } from "../saves/sync-client";
import { classifyLink, pickFolder } from "../core/folder-picker";
import { askConfirm, askText, tell } from "../core/ask";

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

/** The client entered here, to show in its fields (fetched when the tab opens; it's the person's own, on their computer). */
let shownClient: { id: string; secret: string } | null = null;
/** The Dropbox app key entered here (fetched when the tab opens), and whether its guide is open. */
let shownKey: string | null = null, dropboxGuideOpen = false;

/** Registering your own Dropbox app, step by step (the same as docs/dropbox-sync.md). */
const DROPBOX_GUIDE = () => `<ol class="set-steps sync-guide">
  <li><b>Open the Dropbox App Console</b> and sign in with your Dropbox account. It's free.<br>${link("https://www.dropbox.com/developers/apps", "Dropbox App Console")}</li>
  <li><b>Create app:</b> choose <i>Scoped access</i>, then <b>Full Dropbox</b> (needed to see folders others shared with you; the app only opens your sync folders). Name it anything not taken yet, like “Trip Planner” and your name. Press <i>Create app</i>.</li>
  <li><b>Permissions</b> tab: tick these, then press <i>Submit</i> at the bottom:<br>${["files.metadata.read", "files.content.read", "files.content.write", "sharing.read", "sharing.write"].map((x) => `<code>${x}</code>`).join(" ")}</li>
  <li><b>Settings</b> tab, under <i>OAuth 2</i> → <i>Redirect URIs</i>: paste this and press <i>Add</i>: ${copyable("http://localhost:47618/")}Leave <i>Allow public clients (Implicit Grant &amp; PKCE)</i> on <i>Allow</i>.</li>
  <li><b>Copy the App key</b> from the top of the Settings tab, paste it below and press <i>Save</i>. (The app secret isn't needed.)</li>
  <li><b>Sign in to Dropbox</b> and allow the app.</li>
</ol>
<p class="hint">On your other computers, paste the same app key. A new Dropbox app can only be used by your own account at first: friends make their own the same way, or you press <i>Enable additional users</i> on its Settings tab to let them use yours (then they count towards its limit of 500 users).</p>`;

function dropboxCards(s: SyncStatus) {
  const d = s.dropbox;
  const account = !d?.configured ? `<p class="hint">To sync with Dropbox folders, set up your own Dropbox app once below (about 5 minutes). If the Dropbox app is installed on this computer, you can instead add its folder from <i>This computer</i>.</p>`
    : d.signedIn
      ? `<div class="set-row"><div><b class="status"><span class="dot ok"></span> Signed in as ${esc(d.name || d.email)}</b><div class="hint">${esc(d.email)}</div></div>
          <button type="button" class="btn" id="dbxOut">Sign out</button></div>`
      : `<div class="set-row"><div><b class="status"><span class="dot ${d.expired ? "warn" : "off"}"></span> ${d.expired ? "Dropbox signed this computer out" : "Not signed in"}</b>
          <div class="hint">${d.signingIn ? "Finish signing in in your browser (the page Dropbox opened). Closed it, or Dropbox showed an error? Open it again." : "Your browser opens Dropbox's sign-in page; allow the app there."}</div></div>
          <button type="button" class="btn solid" id="dbxIn">${icon("key")} ${d.signingIn ? "Open Dropbox again" : "Sign in to Dropbox"}</button></div>
         ${d.signInError ? `<p class="error-text">${icon("warn")} ${esc(d.signInError)}</p>` : ""}`;
  const guide = `<details class="sync-guide-box" id="dbxGuide"${dropboxGuideOpen || !d?.configured ? " open" : ""}><summary>${d?.configured ? "How to make a Dropbox app" : "Step-by-step: make your own Dropbox app (about 5 minutes, once)"}</summary>${DROPBOX_GUIDE()}</details>`;
  const key = d?.keyFrom === "env" ? `<p class="hint">App key from the DROPBOX_APP_KEY environment variable.</p>`
    : `<div class="sync-add"><input id="dbxKey" type="text" placeholder="App key (from the app's Settings tab)" autocomplete="off" spellcheck="false" value="${esc(shownKey || "")}"><button type="button" class="btn solid" id="dbxKeySave">${icon("check")} Save</button>${d?.configured ? `<button type="button" class="btn" id="dbxKeyRemove">Remove</button>` : ""}</div>`;
  return `<div class="set-card"><b class="card-title">${icon("box")} Dropbox</b>${account}</div>
    <div class="set-card"><div class="set-row"><div><b>Your Dropbox app</b><div class="hint">Syncing with Dropbox signs in through your own free Dropbox app, so nobody shares anyone else's. Its key stays on this computer.</div></div></div>${key}${guide}</div>`;
}

function clientCard(s: SyncStatus) {
  const c = shownClient || { id: "", secret: "" };
  const fields = `<div class="sync-add"><input id="syncClientId" type="text" placeholder="Client ID (…apps.googleusercontent.com), or the downloaded JSON" autocomplete="off" spellcheck="false" value="${esc(c.id)}">
    <span class="secret-field"><input id="syncClientSecret" type="password" placeholder="Client secret (GOCSPX-…)" autocomplete="off" spellcheck="false" value="${esc(c.secret)}"><button type="button" class="icon-btn" id="syncSecretShow" title="Show the secret">${icon("eye")}</button></span>
    <button type="button" class="btn solid" id="syncClientSave">${icon("check")} Save</button></div>`;
  const guide = `<details class="sync-guide-box" id="syncGuide"${guideOpen ? " open" : ""}><summary>${s.configured ? "How to get a client ID and secret" : "Step-by-step: get your client ID and secret (about 5–10 minutes, once)"}</summary>${GUIDE()}</details>`;
  if (!s.configured) return `<div class="set-card">
    <div class="set-row"><div><b>Your Google client</b><div class="hint">Syncing signs in with your own free Google “client” (an ID and a secret), so nobody shares anyone else's. It's not the same as an API key, but comes from the same place. Both stay on this computer.</div></div></div>
    ${guide}${fields}</div>`;
  if (s.clientFrom === "env") return `<div class="set-card">
    <div class="set-row"><div><b>Your Google client</b><div class="hint">From the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables. ID: ${esc(s.clientId)}</div></div></div>${guide}</div>`;
  return `<div class="set-card">
    <div class="set-row"><div><b>Your Google client</b><div class="hint">Saved on this computer. To use it on another one, copy both into Settings → Sync there. Changing it signs you out.</div></div>
      <span class="set-inline"><button type="button" class="btn" id="syncClientCopy">${icon("copy")} Copy both</button><button type="button" class="btn" id="syncClientRemove">Remove</button></span></div>
    ${fields}${guide}</div>`;
}

/** Draws the tab into `main`; `again` redraws it (after a change). */
export function renderSync(main: HTMLElement, again: () => void) {
  const s = syncStatus;
  main.innerHTML = syncHtml(s);
  wire(main, again);
  if (!s) loadSyncStatus().then(again);
  // The client's fields show what's saved (once per opening of the tab).
  if (s?.dropbox?.keyFrom === "app" && shownKey === null) api<{ key: string }>("/api/sync/dropbox/key").then((k) => { shownKey = k.key; again(); }, () => {});
  if (s?.clientFrom === "app" && !shownClient) api<{ id: string; secret: string }>("/api/sync/client").then((c) => { shownClient = c; again(); }, () => {});
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
  const account = !s.configured ? "" : s.signedIn
    ? `<div class="set-row"><div><b class="status"><span class="dot ok"></span> Signed in as ${esc(s.name || s.email)}</b><div class="hint">${esc(s.email)}</div></div>
        <button type="button" class="btn" id="syncOut">Sign out</button></div>`
    : `<div class="set-row"><div><b class="status"><span class="dot ${s.expired ? "warn" : "off"}"></span> ${s.expired ? "Google signed this computer out" : "Not signed in"}</b>
        <div class="hint">${s.signingIn ? "Finish signing in in your browser (the page Google opened). Closed it, or Google showed an error? Open it again." : "Your browser opens Google's sign-in page. Google warns that the app isn't verified: press <i>Advanced</i>, then <i>Go to … (unsafe)</i>, and allow Drive access (the app needs it to see trips other people put in shared folders)."}</div></div>
        <button type="button" class="btn solid" id="syncIn">${icon("key")} ${s.signingIn ? "Open Google again" : "Sign in with Google"}</button></div>
       ${s.signInError ? `<p class="error-text">${icon("warn")} ${esc(s.signInError)}</p>` : ""}`;
  const google = `<div class="set-card"><b class="card-title">${icon("drive")} Google Drive</b>
    ${account}${s.configured ? "" : `<p class="hint">To use Google Drive folders (and Drive photo folders that aren't shared publicly), set up your own Google client once below. Folders on this computer work without it.</p>`}</div>${clientCard(s)}`;
  return `${intro}${folders}${google}${dropboxCards(s)}
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

/** While Google's page is open in the browser: look every 2 seconds whether signing in is done. */
function watchSignIn(again: () => void) {
  clearInterval(watching);
  const until = Date.now() + 11 * 60_000;
  watching = window.setInterval(async () => {
    const s = await loadSyncStatus();
    if ((!s?.signingIn && !s?.dropbox?.signingIn) || Date.now() > until) {
      clearInterval(watching);
      if (s?.signedIn || s?.dropbox?.signedIn) toast("Signed in");
    }
    if (document.querySelector("#syncIn, #syncOut, #dbxIn, #dbxOut")) again();
  }, 2000);
}

function wire(main: HTMLElement, again: () => void) {
  const post = async (url: string, body?: object) => api(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
  main.querySelector<HTMLDetailsElement>("#syncGuide")?.addEventListener("toggle", (e) => { guideOpen = (e.target as HTMLDetailsElement).open; });
  $$<HTMLButtonElement>("[data-copy]", main).forEach((b) => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy!).then(() => toast("Copied")); });
  main.querySelector<HTMLButtonElement>("#syncClientSave")?.addEventListener("click", async () => {
    const id = main.querySelector<HTMLInputElement>("#syncClientId")!.value, secret = main.querySelector<HTMLInputElement>("#syncClientSecret")!.value;
    try { setSyncStatus(await post("/api/sync/client", { id, secret })); shownClient = null; guideOpen = false; toast(syncStatus?.signedIn ? "Saved" : "Saved. Now sign in with Google."); again(); }
    catch (e) { toast((e as Error).message); }
  });
  main.querySelector<HTMLButtonElement>("#syncClientCopy")?.addEventListener("click", () => {
    const id = main.querySelector<HTMLInputElement>("#syncClientId")?.value || "", secret = main.querySelector<HTMLInputElement>("#syncClientSecret")?.value || "";
    navigator.clipboard.writeText(`${id}\n${secret}`).then(() => toast("Copied the client ID and secret"));
  });
  main.querySelector<HTMLButtonElement>("#syncSecretShow")?.addEventListener("click", (e) => {
    const input = main.querySelector<HTMLInputElement>("#syncClientSecret")!, b = e.currentTarget as HTMLButtonElement, show = input.type === "password";
    input.type = show ? "text" : "password";
    b.innerHTML = icon(show ? "eyeOff" : "eye"); b.title = show ? "Hide the secret" : "Show the secret";
  });
  main.querySelector<HTMLButtonElement>("#syncClientRemove")?.addEventListener("click", async () => {
    if (!await askConfirm({ title: "Remove your Google client?", text: "The client ID and secret are deleted from this computer. You're signed out and trips stop syncing; nothing is deleted, here or in Drive.", ok: "Remove", danger: true })) return;
    setSyncStatus(await post("/api/sync/client/remove")); shownClient = null; again();
  });
  // Dropbox: the app key, signing in and out.
  main.querySelector<HTMLDetailsElement>("#dbxGuide")?.addEventListener("toggle", (e) => { dropboxGuideOpen = (e.target as HTMLDetailsElement).open; });
  main.querySelector<HTMLButtonElement>("#dbxKeySave")?.addEventListener("click", async () => {
    try { setSyncStatus(await post("/api/sync/dropbox/key", { key: main.querySelector<HTMLInputElement>("#dbxKey")!.value })); shownKey = null; dropboxGuideOpen = false; toast(syncStatus?.dropbox.signedIn ? "Saved" : "Saved. Now sign in to Dropbox."); again(); }
    catch (e) { toast((e as Error).message); }
  });
  main.querySelector<HTMLButtonElement>("#dbxKeyRemove")?.addEventListener("click", async () => {
    if (!await askConfirm({ title: "Remove your Dropbox app key?", text: "It's deleted from this computer. You're signed out of Dropbox and its folders stop syncing; nothing is deleted, here or in Dropbox.", ok: "Remove", danger: true })) return;
    setSyncStatus(await post("/api/sync/dropbox/key", { key: "" })); shownKey = null; again();
  });
  main.querySelector<HTMLButtonElement>("#dbxIn")?.addEventListener("click", async () => {
    try { await post("/api/sync/dropbox/signin"); await loadSyncStatus(); again(); watchSignIn(again); }
    catch (e) { toast((e as Error).message); }
  });
  main.querySelector<HTMLButtonElement>("#dbxOut")?.addEventListener("click", async () => {
    if (!await askConfirm({ title: "Sign out of Dropbox?", text: "Dropbox folders stop syncing until you sign in again. Nothing is deleted, here or in Dropbox.", ok: "Sign out" })) return;
    setSyncStatus(await post("/api/sync/dropbox/signout")); again();
  });
  main.querySelector<HTMLButtonElement>("#syncIn")?.addEventListener("click", async () => {
    try { await post("/api/sync/signin"); await loadSyncStatus(); again(); watchSignIn(again); }
    catch (e) { toast((e as Error).message); }
  });
  main.querySelector<HTMLButtonElement>("#syncOut")?.addEventListener("click", async () => {
    if (!await askConfirm({ title: "Sign out of Google?", text: "Trips stop syncing until you sign in again. Nothing is deleted, here or in Drive.", ok: "Sign out" })) return;
    setSyncStatus(await post("/api/sync/signout")); again();
  });
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
