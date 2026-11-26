// Connecting Google or Dropbox, one step per screen, in a window over whatever is open (Settings → Accounts, and the
// Connect buttons where a feature needs an account: Sync, Photos, Gemini's exact limits). Each person uses their own free
// app at Google or Dropbox, so the steps make it, paste its ID here and sign in. Only the steps the feature needs are
// shown; with a Google client already saved, only what a new feature adds (an API, a permission, signing in again). The
// step it was on is remembered, and a click outside closes it.
import type { SyncStatus } from "../../../shared/types";
import { api, closeOnBackdrop, esc, toast } from "../core/dom";
import { ext, icon } from "../core/icons";
import { loadSyncStatus, setSyncStatus, syncStatus } from "../saves/sync-client";

export type Account = "google" | "dropbox";
/** What it's for: Drive (sync and photos), Gemini's exact limits, or Dropbox sync. */
export type Purpose = "drive" | "quotas" | "dropbox";

const link = (url: string, text: string) => `<a class="btn" href="${url}" target="_blank" rel="noopener">${text}${ext()}</a>`;
const copyable = (text: string) => `<span class="link-row"><code>${esc(text)}</code><button type="button" class="icon-btn" data-copy="${esc(text)}" title="Copy">${icon("copy")}</button></span>`;
const apiPage = (id: string, name: string) => link(`https://console.cloud.google.com/apis/library/${id}`, name);

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const CLOUD_SCOPES = ["https://www.googleapis.com/auth/cloud-platform.read-only", "https://www.googleapis.com/auth/cloud-billing.readonly"];
const NAMES: Record<Purpose, string> = { drive: "Google Drive", quotas: "Gemini's exact limits", dropbox: "Dropbox" };

interface Step {
  id: string;
  title: string;
  body: (s: SyncStatus) => string;
  /** Run when Next is pressed; false keeps the step (something is missing). */
  next?: (d: HTMLDialogElement, s: SyncStatus) => Promise<boolean>;
}

/** Whether the account is signed in with what this needs. */
export function connected(s: SyncStatus | null, purpose: Purpose) {
  if (!s) return false;
  if (purpose === "dropbox") return !!s.dropbox?.signedIn;
  return s.signedIn && (purpose === "drive" ? s.drive !== false : !!s.cloud);
}

/** Saves what Google is used for, which decides what signing in asks for: this, and what the sign-in allows already. */
async function saveUse(purpose: Purpose) {
  const s = syncStatus, drive = purpose === "drive" || (!!s?.signedIn && s.drive !== false);
  const google: Record<string, boolean> = { sync: drive, photos: drive };
  if (purpose === "quotas") google.quotas = true;
  else if (s?.cloud) google.quotas = true;
  await api("/api/settings", { method: "POST", body: JSON.stringify({ google }) });
}

const post = async (url: string, body?: object) => api<SyncStatus>(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

function signInStep(purpose: Purpose): Step {
  const dbx = purpose === "dropbox";
  return {
    id: "signin", title: "Sign in",
    body: (s) => {
      const d = dbx ? s.dropbox : s, busy = !!d?.signingIn;
      if (connected(s, purpose)) return `<p class="wz-done">${icon("check")} <b>Connected.</b> ${esc((dbx ? s.dropbox.name || s.dropbox.email : s.name || s.email) || "")}</p>`;
      return `<p>${dbx ? "Your browser opens Dropbox's page: sign in and allow the app."
        : `Your browser opens Google's page. Sign in${purpose === "quotas" ? " with the account that owns the project" : ""}. Google warns that the app isn't verified, because it's your own private app: press <i>Advanced</i>, then <i>Go to Trip Planner (unsafe)</i>, and <b>leave every box ticked</b>.`}</p>
        <button type="button" class="btn solid" data-signin>${icon("key")} ${busy ? "Open the page again" : dbx ? "Sign in to Dropbox" : "Sign in with Google"}</button>
        ${busy ? `<p class="hint"><span class="sx-spin small"></span> Waiting for you to finish in the browser…</p>` : ""}
        ${d?.signInError ? `<p class="error-text">${icon("warn")} ${esc(d.signInError)}</p>` : ""}
        ${dbx ? "" : `<p class="hint">“Access blocked: … has not completed the Google verification process”? The app isn't published yet (the “Publish it” step).</p>`}`;
    },
  };
}

function googleSteps(purpose: Purpose, s: SyncStatus, all: boolean): Step[] {
  const quotas = purpose === "quotas";
  const drive = !quotas || (s.signedIn && s.drive !== false);
  const scopes = [...(drive ? [DRIVE_SCOPE] : []), ...(quotas || s.cloud ? CLOUD_SCOPES : [])];
  const steps: (Step & { setupOnly?: boolean })[] = [
    { id: "project", title: "Pick a project", setupOnly: !quotas, body: () => (quotas
      ? `<p>Gemini's limits belong to the project your Gemini key is in. In the Google Cloud Console, pick it at the top: AI Studio calls it “Default Gemini Project” (its ID starts with <code>gen-lang-client-</code>).</p>
         <p class="wz-links">${link("https://console.cloud.google.com/", "Google Cloud Console")}${link("https://aistudio.google.com/apikey", "Which project is my key in?")}</p>`
      : `<p>Open the Google Cloud Console and pick a project at the top, or make one (<i>New project</i>, any name, e.g. “Trip Planner”). It's free and needs no payment details.</p>
         <p class="wz-links">${link("https://console.cloud.google.com/", "Google Cloud Console")}</p>`) },
    { id: "apis", title: quotas ? "Switch on two APIs" : "Switch on the Drive API", body: () => `<p>Open ${quotas ? "each page" : "the page"} and press <b>Enable</b>. If it says <i>Manage</i>, it's on already.</p>
      <p class="wz-links">${quotas ? apiPage("serviceusage.googleapis.com", "Service Usage API") + apiPage("cloudbilling.googleapis.com", "Cloud Billing API") : apiPage("drive.googleapis.com", "Google Drive API")}</p>` },
    { id: "brand", title: "Name the app", setupOnly: true, body: () => `<p>Press <i>Get started</i> (not shown if the project already has a sign-in screen). App name “Trip Planner”, your email as support and contact email, audience <b>External</b>, then <i>Create</i>.</p>
      <p class="wz-links">${link("https://console.cloud.google.com/auth/branding", "Branding")}</p>
      <p>Then, still on <i>Branding</i> under <i>App domain</i>, fill these in and press <i>Save</i>:</p>
      <p class="wz-field">Application home page ${copyable("https://github.com/notetuwu/trip-planner")}</p>
      <p class="wz-field">Privacy policy link ${copyable("https://github.com/notetuwu/trip-planner/blob/main/PRIVACY.md")}</p>
      <p class="wz-field">Authorized domains ${copyable("github.com")}</p>` },
    { id: "publish", title: "Publish it", setupOnly: true, body: () => `<p>Press <b>Publish app</b> and confirm, so it says <i>In production</i>. Left in <i>Testing</i>, Google signs you out every 7 days. No need to send it for verification.</p>
      <p class="wz-links">${link("https://console.cloud.google.com/auth/audience", "Audience")}</p>` },
    { id: "scopes", title: "Add the permission" + (scopes.length > 1 ? "s" : ""), body: () => `<p>Press <i>Add or remove scopes</i>, paste ${scopes.length > 1 ? "these (one per line)" : "this"} under <i>Manually add scopes</i>, then <i>Add to table</i> → <i>Update</i> → <b>Save</b>.</p>
      ${scopes.map((x) => `<p class="wz-field">${copyable(x)}</p>`).join("")}
      <p class="wz-links">${link("https://console.cloud.google.com/auth/scopes", "Data access")}</p>` },
    { id: "client", title: "Create the client", setupOnly: true, body: (now) => `<p>Press <i>Create client</i>, type <b>Desktop app</b>, then <i>Create</i>. Copy the ID and secret straight away: Google shows the secret only once.</p>
      <p class="wz-links">${link("https://console.cloud.google.com/auth/clients", "Clients")}</p>
      ${now.clientFrom === "env" ? `<p class="hint">A client is set by the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.</p>`
        : `<label class="wz-input">Client ID<input id="wzId" type="text" placeholder="…apps.googleusercontent.com (or paste the downloaded JSON)" autocomplete="off" spellcheck="false"></label>
      <label class="wz-input">Client secret<input id="wzSecret" type="password" placeholder="GOCSPX-…" autocomplete="off" spellcheck="false"></label>
      ${now.configured ? `<p class="hint">A client is saved already; leave these empty to keep it. A different one signs you out.</p>` : ""}`}`,
      next: async (d, now) => {
        const id = d.querySelector<HTMLInputElement>("#wzId")?.value.trim() || "", secret = d.querySelector<HTMLInputElement>("#wzSecret")?.value.trim() || "";
        if (!id && !secret) { if (now.configured) return true; toast("Paste the client ID and secret first"); return false; }
        try { setSyncStatus(await post("/api/sync/client", { id, secret })); toast("Saved"); return true; }
        catch (e) { toast((e as Error).message); return false; }
      } },
    signInStep(purpose),
  ];
  // With a client already saved, setting it up again isn't needed: only what this adds.
  return s.configured && !all ? steps.filter((x) => !x.setupOnly) : steps;
}

function dropboxSteps(): Step[] {
  return [
    { id: "create", title: "Create a Dropbox app", body: () => `<p>Open the App Console, press <i>Create app</i>, choose <i>Scoped access</i>, then <b>Full Dropbox</b> (needed to see folders others shared with you; the planner only opens your sync folders). Name it anything not taken, like “Trip Planner” and your name.</p>
      <p class="wz-links">${link("https://www.dropbox.com/developers/apps", "Dropbox App Console")}</p>` },
    { id: "perms", title: "Allow five things", body: () => `<p>On the <i>Permissions</i> tab, tick these, then press <b>Submit</b> at the bottom:</p>
      <p class="wz-codes">${["files.metadata.read", "files.content.read", "files.content.write", "sharing.read", "sharing.write"].map((x) => `<code>${x}</code>`).join(" ")}</p>` },
    { id: "redirect", title: "Add the address", body: () => `<p>On the <i>Settings</i> tab, under <i>OAuth 2 → Redirect URIs</i>, paste this and press <i>Add</i>. Leave <i>Allow public clients</i> on <i>Allow</i>.</p>
      <p class="wz-field">${copyable("http://localhost:47618/")}</p>` },
    { id: "key", title: "Paste the app key", body: (s) => `<p>Copy the <b>App key</b> from the top of the <i>Settings</i> tab. The app secret isn't needed.</p>
      ${s.dropbox.keyFrom === "env" ? `<p class="hint">A key is set by the DROPBOX_APP_KEY environment variable.</p>`
        : `<label class="wz-input">App key<input id="wzKey" type="text" autocomplete="off" spellcheck="false"></label>
      ${s.dropbox.configured ? `<p class="hint">A key is saved already; leave this empty to keep it.</p>` : ""}`}`,
      next: async (d, s) => {
        const key = d.querySelector<HTMLInputElement>("#wzKey")?.value.trim() || "";
        if (!key) { if (s.dropbox.configured) return true; toast("Paste the app key first"); return false; }
        try { setSyncStatus(await post("/api/sync/dropbox/key", { key })); toast("Saved"); return true; }
        catch (e) { toast((e as Error).message); return false; }
      } },
    signInStep("dropbox"),
  ];
}

const remember = (purpose: Purpose) => `trip-planner-connect-${purpose}`;

/**
 * Opens the steps for `purpose`; onDone runs when it closes (connected or not). Already connected with what it needs:
 * nothing to do but turn it on. `at`: a step to open at (the client's or key's, to change it), showing every step.
 */
export async function openConnect(purpose: Purpose, onDone: () => void = () => {}, at = "") {
  const first = await loadSyncStatus();
  if (!first) { toast("Couldn't reach the planner"); return; }
  if (!at && connected(first, purpose)) {
    if (purpose !== "dropbox") await saveUse(purpose);
    toast(`${NAMES[purpose]}: connected`);
    onDone();
    return;
  }
  let s: SyncStatus = first, all = !!at, watching: number | undefined;
  const steps = () => (purpose === "dropbox" ? dropboxSteps() : googleSteps(purpose, s, all));
  let saved = "";
  try { saved = localStorage.getItem(remember(purpose)) || ""; } catch { /* private window */ }
  // Back where it was; otherwise signing in when everything before it is there already.
  let current = at || saved || (purpose === "dropbox" && s.dropbox?.configured ? "signin" : "");

  const d = document.createElement("dialog");
  d.className = "keys-dialog wz-dialog";
  document.body.append(d);
  closeOnBackdrop(d);

  const draw = () => {
    const list = steps(), found = list.findIndex((x) => x.id === current), i = Math.max(0, found), step = list[i];
    current = step.id;
    try { localStorage.setItem(remember(purpose), current); } catch { /* private window */ }
    const last = i === list.length - 1, done = connected(s, purpose);
    // What was typed stays while the step redraws.
    const typed = [...d.querySelectorAll<HTMLInputElement>(".wz-input input")].map((x) => [x.id, x.value]);
    d.innerHTML = `<form method="dialog" class="keys-close"><button class="icon-btn" title="Close">${icon("x")}</button></form>
      <p class="wz-for">Connect ${NAMES[purpose]} · step ${i + 1} of ${list.length}</p>
      <div class="wz-bar">${list.map((x, n) => `<button type="button" class="wz-dot${n < i ? " past" : n === i ? " on" : ""}" data-step="${x.id}" title="${esc(x.title)}"></button>`).join("")}</div>
      <h3>${esc(step.title)}</h3>
      <div class="wz-body">${step.body(s)}</div>
      <div class="wz-acts">
        <button type="button" class="btn" data-back ${i ? "" : "hidden"}>Back</button>
        ${purpose !== "dropbox" && s.configured && !all ? `<button type="button" class="link-btn" data-all>Show every setup step</button>` : ""}
        <span></span>
        ${last ? `<button type="button" class="btn${done ? " solid" : ""}" data-finish>${done ? "Done" : "Close"}</button>` : `<button type="button" class="btn solid" data-next>Next</button>`}
      </div>`;
    for (const [id, value] of typed) { const el = d.querySelector<HTMLInputElement>(`#${id}`); if (el) el.value = value; }
    d.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy!).then(() => toast("Copied")); });
    d.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => { b.onclick = () => { current = b.dataset.step!; draw(); }; });
    d.querySelector<HTMLButtonElement>("[data-back]")!.onclick = () => { current = list[i - 1].id; draw(); };
    d.querySelector<HTMLButtonElement>("[data-all]")?.addEventListener("click", () => { all = true; current = "project"; draw(); });
    d.querySelector<HTMLButtonElement>("[data-next]")?.addEventListener("click", async () => {
      if (step.next && !await step.next(d, s)) return;
      s = syncStatus || s;
      const now = steps(), at2 = now.findIndex((x) => x.id === step.id);
      current = now[Math.min(now.length - 1, at2 + 1)].id;
      draw();
    });
    d.querySelector<HTMLButtonElement>("[data-finish]")?.addEventListener("click", () => d.close());
    d.querySelector<HTMLButtonElement>("[data-signin]")?.addEventListener("click", async () => {
      try {
        if (purpose !== "dropbox") await saveUse(purpose);
        await post(purpose === "dropbox" ? "/api/sync/dropbox/signin" : "/api/sync/signin");
        s = await loadSyncStatus() || s;
        draw();
        watch();
      } catch (e) { toast((e as Error).message); }
    });
  };
  // While the page in the browser is open: look every 2 seconds whether signing in is done.
  const watch = () => {
    clearInterval(watching);
    const until = Date.now() + 11 * 60_000;
    watching = window.setInterval(async () => {
      const now = await loadSyncStatus();
      if (!now) return;
      const busy = purpose === "dropbox" ? now.dropbox?.signingIn : now.signingIn;
      s = now;
      if (!busy || Date.now() > until) { clearInterval(watching); draw(); }
    }, 2000);
  };
  d.addEventListener("close", () => {
    clearInterval(watching);
    if (connected(s, purpose)) { try { localStorage.removeItem(remember(purpose)); } catch { /* private window */ } }
    d.remove();
    onDone();
  });
  draw();
  d.showModal();
}
