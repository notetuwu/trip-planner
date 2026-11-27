// Connecting Google or Dropbox, one step per screen, in a window over whatever is open (Settings → Accounts, and the
// Connect buttons where a feature needs an account: Sync, Photos, Gemini's exact limits). Each person uses their own free
// app at Google or Dropbox, so the steps make it, paste its ID here and sign in. For Google it first asks how much help
// is wanted: guided or a short checklist (google-steps.ts). Only the steps the feature needs are shown; with a Google
// client already saved, only what a new feature adds (an API, signing in again). The way chosen and the
// step it was on are remembered, and a click outside closes it.
import type { SyncStatus } from "../../../shared/types";
import { api, closeOnBackdrop, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { loadSyncStatus, setSyncStatus, syncStatus } from "../saves/sync-client";
import { type Mode, type Step, copyable, googleSteps, link } from "./google-steps";

export type Account = "google" | "dropbox";
/** What it's for: Drive (sync and photos), Gemini's exact limits, Gmail (booking emails), or Dropbox (sync and photos). */
export type Purpose = "drive" | "quotas" | "gmail" | "dropbox";

const NAMES: Record<Purpose, string> = { drive: "Google Drive", quotas: "Gemini's exact limits", gmail: "Gmail", dropbox: "Dropbox" };

/** Whether the account is signed in with what this needs. */
export function connected(s: SyncStatus | null, purpose: Purpose) {
  if (!s) return false;
  if (purpose === "dropbox") return !!s.dropbox?.signedIn;
  if (purpose === "gmail") return !!s.gmail?.some((a) => !a.expired);
  return s.signedIn && (purpose === "drive" ? s.drive !== false : !!s.cloud);
}

/** Saves what Google is used for, which decides what signing in asks for: this, and what the sign-in allows already. */
async function saveUse(purpose: Purpose) {
  if (purpose === "gmail") return; // its own sign-in: nothing about the other one changes
  const s = syncStatus, drive = purpose === "drive" || (!!s?.signedIn && s.drive !== false);
  const google: Record<string, boolean> = { sync: drive, photos: drive };
  if (purpose === "quotas" || s?.cloud) google.quotas = true;
  await api("/api/settings", { method: "POST", body: JSON.stringify({ google }) });
}

const post = async (url: string, body?: object) => api<SyncStatus>(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

function signInStep(purpose: Purpose): Step {
  const dbx = purpose === "dropbox";
  return {
    id: "signin", title: "Sign in",
    body: (s) => {
      const d = dbx ? s.dropbox : s, busy = !!d?.signingIn;
      const who = purpose === "gmail" ? (s.gmail || []).filter((a) => !a.expired).map((a) => a.email).join(", ") : dbx ? s.dropbox.name || s.dropbox.email : s.name || s.email;
      if (connected(s, purpose)) return `<p class="wz-done">${icon("check")} <b>Connected.</b> ${esc(who || "")}</p>`;
      return `<p>${dbx ? "Your browser opens Dropbox's page: sign in and allow the app."
        : `Your browser opens Google's page. Sign in${purpose === "quotas" ? " with the account that owns the project" : ""}. Google warns that the app isn't verified, because it's your own private app: press <i>Advanced</i>, then <i>Go to Trip Planner (unsafe)</i>, and <b>leave every box ticked</b>: they are the permissions the planner needs.`}</p>
        ${purpose === "gmail" ? `<p class="hint">Gmail access is read-only: the planner can't send, change or delete mail. It only looks at your mail while you have “Add from Gmail” open. It can be another account than the one for Drive.</p>` : ""}
        ${purpose !== "drive" ? "" : `<p class="hint">Google offers no narrower permission than your whole Drive for shared folders. The planner only opens the folders you add to it and never deletes anything.</p>`}
        <button type="button" class="btn solid" data-signin>${icon("key")} ${busy ? "Open the page again" : dbx ? "Sign in to Dropbox" : "Sign in with Google"}</button>
        ${busy ? `<p class="hint"><span class="sx-spin small"></span> Waiting for you to finish in the browser…</p>` : ""}
        ${d?.signInError ? `<p class="error-text">${icon("warn")} ${esc(d.signInError)}</p>` : ""}
        ${dbx ? "" : `<p class="hint">“Access blocked: … has not completed the Google verification process”? The app isn't published yet (the “Publish it” step).</p>`}`;
    },
  };
}

function dropboxSteps(): Step[] {
  return [
    { id: "create", title: "Create a Dropbox app", body: () => `<p>Open the App Console, press <i>Create app</i>, choose <i>Scoped access</i>, then <b>Full Dropbox</b> (needed to see folders others shared with you; the planner only opens the sync and photo folders you add). Name it anything not taken, like “Trip Planner” and your name.</p>
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
const MODE_KEY = "trip-planner-connect-mode";
/** The screen before Google's steps, where the way through them is picked. */
const CHOOSE = "choose";

const option = (mode: Mode, name: string, text: string) => `<button type="button" class="wz-option" data-mode="${mode}"><b>${name}</b><span>${text}</span></button>`;

function chooser(s: SyncStatus) {
  return `<p>${s.configured ? "Your Google app is saved already, so only what's missing is shown."
    : "Google needs a one-time setup: you make a free, private app there that lets this planner reach your account."} How much help do you want?</p>
    <div class="wz-options">
      ${option("guided", "I'm new to this", "One step at a time, with what you're looking at and why you're doing it.")}
      ${option("quick", "I know the Google Cloud Console", "A short checklist with every link and value on one page.")}
    </div>`;
}

/** Connects one more Gmail account (the Google client is set up already): Google's page opens to pick it; onDone runs
 *  when that's finished, however it went. */
export async function addGmail(onDone: () => void) {
  try {
    await post("/api/sync/gmail/signin");
    toast("Pick the account on Google's page in your browser");
  } catch (e) { toast((e as Error).message); return; }
  const until = Date.now() + 11 * 60_000;
  const watching = window.setInterval(async () => {
    const now = await loadSyncStatus();
    if (now?.signingIn && Date.now() < until) return;
    clearInterval(watching);
    if (now?.signInError) toast(now.signInError);
    onDone();
  }, 2000);
}

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
  let saved = "", mode: Mode = "guided";
  try {
    saved = localStorage.getItem(remember(purpose)) || "";
    if (localStorage.getItem(MODE_KEY) === "quick") mode = "quick";
  } catch { /* private window */ }
  const google = purpose !== "dropbox";
  const steps = () => (google ? [...googleSteps(purpose as "drive" | "quotas" | "gmail", s, all, mode), signInStep(purpose)] : dropboxSteps());
  // Back where it was; otherwise Google's first setup asks how to go through it, and Dropbox starts at signing in when
  // everything before it is there already.
  let current = at || saved || (google ? (s.configured ? "" : CHOOSE) : s.dropbox?.configured ? "signin" : "");

  const d = document.createElement("dialog");
  d.className = "keys-dialog wz-dialog";
  document.body.append(d);
  closeOnBackdrop(d);

  // What was typed stays while the step redraws, or while another way through is picked.
  const typed = new Map<string, string>();
  const keep = () => { try { localStorage.setItem(remember(purpose), current); } catch { /* private window */ } };
  const close = `<form method="dialog" class="keys-close"><button class="icon-btn" title="Close">${icon("x")}</button></form>`;
  const drawChooser = () => {
    keep();
    d.innerHTML = `${close}
      <p class="wz-for">Connect ${NAMES[purpose]}</p>
      <h3>Have you done this before?</h3>
      <div class="wz-body">${chooser(s)}</div>`;
    d.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => { b.onclick = () => {
      mode = b.dataset.mode as Mode;
      try { localStorage.setItem(MODE_KEY, mode); } catch { /* private window */ }
      current = "";
      draw();
    }; });
  };

  const draw = () => {
    for (const x of d.querySelectorAll<HTMLInputElement>(".wz-input input")) typed.set(x.id, x.value);
    if (google && current === CHOOSE) { drawChooser(); return; }
    const list = steps(), found = list.findIndex((x) => x.id === current), i = Math.max(0, found), step = list[i];
    current = step.id;
    keep();
    const last = i === list.length - 1, done = connected(s, purpose);
    d.innerHTML = `${close}
      <p class="wz-for">Connect ${NAMES[purpose]} · step ${i + 1} of ${list.length}</p>
      <div class="wz-bar">${list.map((x, n) => `<button type="button" class="wz-dot${n < i ? " past" : n === i ? " on" : ""}" data-step="${x.id}" title="${esc(x.title)}"></button>`).join("")}</div>
      <h3>${esc(step.title)}</h3>
      <div class="wz-body">${step.body(s)}</div>
      <div class="wz-acts">
        <button type="button" class="btn" data-back ${i || google ? "" : "hidden"}>Back</button>
        ${google && s.configured && !all ? `<button type="button" class="link-btn" data-all>Show every setup step</button>` : ""}
        <span></span>
        ${last ? `<button type="button" class="btn${done ? " solid" : ""}" data-finish>${done ? "Done" : "Close"}</button>` : `<button type="button" class="btn solid" data-next>Next</button>`}
      </div>`;
    for (const [id, value] of typed) { const el = d.querySelector<HTMLInputElement>(`#${id}`); if (el) el.value = value; }
    d.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => { b.onclick = () => navigator.clipboard.writeText(b.dataset.copy!).then(() => toast("Copied")); });
    d.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((b) => { b.onclick = () => { current = b.dataset.step!; draw(); }; });
    d.querySelector<HTMLButtonElement>("[data-back]")!.onclick = () => { current = i ? list[i - 1].id : CHOOSE; draw(); };
    d.querySelector<HTMLButtonElement>("[data-all]")?.addEventListener("click", () => { all = true; current = ""; draw(); });
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
        await post(purpose === "dropbox" ? "/api/sync/dropbox/signin" : purpose === "gmail" ? "/api/sync/gmail/signin" : "/api/sync/signin");
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
