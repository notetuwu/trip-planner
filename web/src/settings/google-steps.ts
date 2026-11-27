// What the connect window (connect-wizard.ts) says for Google, in its two ways: guided, for a first time (one thing per
// screen: what the page is, why it's needed, what to press), and quick, for people who know the console (everything on
// one checklist). Both are made from the same parts, so the links and values are the same.
import type { SyncStatus } from "../../../shared/types";
import { api, esc, toast } from "../core/dom";
import { ext, icon } from "../core/icons";
import { setSyncStatus } from "../saves/sync-client";

export type Mode = "guided" | "quick";
/** What the steps are for. */
export type Use = "drive" | "quotas" | "gmail";

export interface Step {
  id: string;
  title: string;
  body: (s: SyncStatus) => string;
  /** Run when Next is pressed; false keeps the step (something is missing). */
  next?: (d: HTMLDialogElement, s: SyncStatus) => Promise<boolean>;
}

interface Part {
  id: string;
  title: string;
  /** Left out when a client is saved already. */
  setupOnly?: boolean;
  /** Guided: what the page is, why this is needed, and what to do there. */
  what: string;
  why: string;
  how: string[];
  /** What can't be undone, shown in a box at the top of the screen. */
  warn?: string;
  /** Quick: the whole step in a line or two. */
  short: string;
  links: string;
  /** Values to copy or fields to fill, below the instructions. */
  fields?: (s: SyncStatus) => string;
  next?: Step["next"];
}

export const link = (url: string, text: string) => `<a class="btn" href="${url}" target="_blank" rel="noopener">${text}${ext()}</a>`;
export const copyable = (text: string) => `<span class="link-row"><code>${esc(text)}</code><button type="button" class="icon-btn" data-copy="${esc(text)}" title="Copy">${icon("copy")}</button></span>`;
const apiPage = (id: string, name: string) => link(`https://console.cloud.google.com/apis/library/${id}`, name);
/** A box of Google's form, under the name Google gives it: what to paste there, or why it stays empty. */
const box = (name: string, value: string, note = "") => `<div class="wz-box"><span>${name}</span>${value ? copyable(value) : `<i>${note}</i>`}</div>`;

/** The lower half of Google's Branding page, in its order, so each value can be matched to its box. */
const domainForm = () => `<div class="wz-form">
    <h4>App domain</h4>
    ${box("Application home page", "https://github.com/notetuwu/trip-planner")}
    ${box("Application privacy policy link", "https://github.com/notetuwu/trip-planner/blob/main/PRIVACY.md")}
    ${box("Application terms of service link", "", "Leave empty")}
    <h4>Authorized domains</h4>
    ${box("Press <b>+ Add domain</b>, then paste into the new box", "github.com")}
  </div>`;

const DOMAIN_HELP = `<details class="wz-help"><summary>Something not working?</summary><ul>
    <li><b>You can't find App domain:</b> it's on the <i>Branding</i> page, below the app name and logo. Scroll down. If you only see <i>Get started</i>, do the step before this one first.</li>
    <li><b>Red text under Authorized domains:</b> the box takes only <code>github.com</code>, with no <code>https://</code> and nothing after it. If <code>github.com</code> is listed twice, remove one.</li>
    <li><b>Red text under a link:</b> clear the box and paste again with the copy button, so nothing is missing and there are no spaces.</li>
    <li><b>Save does nothing:</b> look further up and down the page for a box marked red, such as an empty <i>Developer contact information</i> (your email).</li>
    <li><b>Asked to verify the branding:</b> remove the logo if you added one, and don't send anything in.</li>
  </ul></details>`;

const warning = (text = "") => (text ? `<div class="wz-warn" role="note">${icon("warn")}<span>${text}</span></div>` : "");

function clientFields(s: SyncStatus) {
  if (s.clientFrom === "env") return `<p class="hint">A client is set by the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.</p>`;
  return `<label class="wz-input">Client ID<input id="wzId" type="text" placeholder="…apps.googleusercontent.com (or paste the downloaded JSON)" autocomplete="off" spellcheck="false"></label>
    <label class="wz-input">Client secret<input id="wzSecret" type="password" placeholder="GOCSPX-…" autocomplete="off" spellcheck="false"></label>
    ${s.configured ? `<p class="hint">A client is saved already; leave these empty to keep it. A different one signs you out.</p>` : ""}`;
}

async function saveClient(d: HTMLDialogElement, s: SyncStatus) {
  const id = d.querySelector<HTMLInputElement>("#wzId")?.value.trim() || "", secret = d.querySelector<HTMLInputElement>("#wzSecret")?.value.trim() || "";
  if (!id && !secret) { if (s.configured) return true; toast("Paste the client ID and secret first"); return false; }
  try { setSyncStatus(await api<SyncStatus>("/api/sync/client", { method: "POST", body: JSON.stringify({ id, secret }) })); toast("Saved"); return true; }
  catch (e) { toast((e as Error).message); return false; }
}

function parts(use: Use): Part[] {
  const quotas = use === "quotas", gmail = use === "gmail";
  return [
    {
      id: "project", title: "Pick a project", setupOnly: !quotas,
      what: "The <b>Google Cloud Console</b> is Google's settings site for people who connect apps to Google. It's busy and looks technical, but you only need a few pages of it. A <b>project</b> is a folder there that holds one app's settings.",
      why: quotas ? "Gemini's limits belong to the project your Gemini key is in, so the planner has to be set up in that same one."
        : "Everything in the next steps is saved inside a project, so you need one first. It's free and needs no payment details.",
      how: [
        "Open the console and sign in with your Google account. On a first visit, agree to the terms. You can ignore offers of a free trial.",
        quotas ? "Press the project picker at the top left and choose your key's project. AI Studio calls it “Default Gemini Project”, and its ID starts with <code>gen-lang-client-</code>."
          : "Press the project picker at the top left, then <i>New project</i>. Any name works, e.g. “Trip Planner”. Press <i>Create</i>. If you have a Gemini key, pick its project instead (usually “Default Gemini Project”).",
        ...(quotas ? [] : ["A new project isn't selected by itself: Google takes you back while it's still being made, with the progress in a notification at the top right. When it's done, press <i>Select project</i> in that notification (the bell icon opens it again), or choose it in the project picker."]),
        "Check that the picker now shows that project. Look again on each page you open later.",
      ],
      short: quotas ? "Pick the project your Gemini key is in (“Default Gemini Project”, ID <code>gen-lang-client-…</code>)."
        : "Pick or create any project (the Gemini key's one if you have a key). A new one isn't selected by itself: select it once it's made.",
      links: link("https://console.cloud.google.com/", "Google Cloud Console") + (quotas ? link("https://aistudio.google.com/apikey", "Which project is my key in?") : ""),
    },
    {
      id: "apis", title: quotas ? "Switch on two APIs" : `Switch on the ${gmail ? "Gmail" : "Drive"} API`,
      what: `An <b>API</b> is the way one program talks to a Google service. ${quotas ? "Each link opens one service's page" : `The link opens the ${gmail ? "Gmail" : "Drive"} service's page`} in the console, with a big button on it.`,
      why: quotas ? "They're off in a project until you switch them on. These two let the planner read your key's limits and whether billing is on. Switching them on costs nothing."
        : `It's off in a project until you switch it on. Without it the planner can't ${gmail ? "find your booking emails" : "open your trip or photo folders"}, even after you sign in. It costs nothing.`,
      how: [`Open ${quotas ? "each page" : "the page"} and press <b>Enable</b>. If the button says <i>Manage</i>, it's on already.`],
      short: `<b>Enable</b> ${quotas ? "both" : "it"}.`,
      links: quotas ? apiPage("serviceusage.googleapis.com", "Service Usage API") + apiPage("cloudbilling.googleapis.com", "Cloud Billing API") : gmail ? apiPage("gmail.googleapis.com", "Gmail API") : apiPage("drive.googleapis.com", "Google Drive API"),
    },
    {
      id: "brand", title: "Name the app", setupOnly: true,
      what: "<b>Branding</b> is what Google shows on the sign-in page: the app's name and who to contact. Here the “app” is your own private connection between this planner and your Google account.",
      why: "Google doesn't let anyone sign in to an app that has no name. Only you (and anyone you give it to) will see this.",
      how: [
        "Press <i>Get started</i> (not shown if the project already has a sign-in screen).",
        "<b>App name:</b> type “Trip Planner”.",
        "<b>User support email:</b> choose your own email from the list. Press <i>Next</i>.",
        "<b>Audience:</b> pick <b>External</b> (“Internal” is only for company accounts). Press <i>Next</i>.",
        "<b>Contact information:</b> type your email again. Press <i>Next</i>.",
        "<b>Finish:</b> tick the box to agree to Google's policy, press <i>Continue</i>, then <i>Create</i>.",
      ],
      short: "<i>Get started</i>: name “Trip Planner”, audience <b>External</b>, your email.",
      links: link("https://console.cloud.google.com/auth/branding", "Branding"),
    },
    {
      id: "domain", title: "Fill in the app domain", setupOnly: true,
      what: "Further down the same <i>Branding</i> page are boxes for web addresses that tell people about an app: <b>App domain</b> and <b>Authorized domains</b>.",
      why: "Google won't let you publish the app (the next step) while these are empty. You don't need a website of your own: use the planner's public pages below. <i>Authorized domains</i> says which site those links are on.",
      how: [
        "Open <i>Branding</i> and scroll down to the heading <i>App domain</i>.",
        "Fill in the <b>home page</b> and <b>privacy policy</b> links: press the copy button here, click into the box with the same name on Google's page and paste (Ctrl+V, on a Mac ⌘V). The <b>terms of service</b> link doesn't need to be filled in.",
        "Under <i>Authorized domains</i>, press <b>+ Add domain</b> first: that makes the box appear. Paste <code>github.com</code> into it. If it's listed already, leave it as it is.",
        "Scroll to the bottom of Google's page and press <b>Save</b>.",
      ],
      short: "Further down <i>Branding</i>: home page and privacy policy links (terms of service stays empty), <b>+ Add domain</b> for <code>github.com</code>, then <b>Save</b>.",
      links: link("https://console.cloud.google.com/auth/branding", "Branding"),
      fields: () => domainForm() + DOMAIN_HELP,
    },
    {
      id: "publish", title: "Publish it", setupOnly: true,
      what: "The <b>Audience</b> page says who may sign in. A new app is in <i>Testing</i>.",
      why: "In Testing, Google signs you out every 7 days. Publishing stops that. It doesn't list your app anywhere or share anything: nobody can use it without the ID and secret you get shortly.",
      how: [
        "Press <b>Publish app</b> and confirm, so it says <i>In production</i>.",
        "If Google mentions verification, don't send the app in: that's for apps offered to the public.",
      ],
      short: "<b>Publish app</b> (<i>In production</i>), or you're signed out every 7 days. No verification needed.",
      links: link("https://console.cloud.google.com/auth/audience", "Audience"),
    },
    {
      id: "client", title: "Create the client", setupOnly: true,
      what: "A <b>client</b> is a pair of codes, an ID and a secret, that tells Google which app is asking to sign you in.",
      why: "This is what links the planner on this computer to the app you just set up. The secret stays on this computer.",
      warn: "<b>Don't close Google's dialog yet.</b> After you press <i>Create</i> it shows the client ID and secret. Paste both into the fields here and press <i>Next</i> to save them before you close it: Google shows the secret only once.",
      how: [
        "Press <i>Create client</i>, choose the type <b>Desktop app</b> (the planner runs on your computer), then <i>Create</i>.",
        "Leave Google's dialog open. Copy the ID into the field below, then the secret into its field, press <i>Next</i> to save them, and only then close the dialog.",
        "Closed it too early? Create another client and use its ID and secret.",
      ],
      short: "<i>Create client</i>, type <b>Desktop app</b>. Paste both here.",
      links: link("https://console.cloud.google.com/auth/clients", "Clients"),
      fields: clientFields,
      next: saveClient,
    },
  ];
}

const INTRO: Record<Use, string> = { drive: "To sync trips and show photos from Google Drive", quotas: "To read your Gemini key's exact limits", gmail: "To find booking confirmations in your Gmail" };
const intro = (use: Use): Step => ({
  id: "intro", title: "Before you start",
  body: () => `<p>${INTRO[use]}, the planner needs your permission at Google. It comes without an app of its own there, so you make a small private one, which only you control.</p>
    <ul>
      <li><b>What you'll do:</b> click through a few pages on Google's site, then copy two codes back here and sign in.</li>
      <li><b>How long:</b> about 5 to 10 minutes, once. You can close this window and carry on later.</li>
      <li><b>Cost:</b> nothing. No payment details are needed.</li>
    </ul>
    <p>Keep this window open next to your browser. Each step has a button that opens the right page. Google renames its menus now and then, so a label may differ a little.</p>`,
});

const guidedStep = (p: Part): Step => ({
  id: p.id, title: p.title, next: p.next,
  body: (s) => `${warning(p.warn)}<dl class="wz-explain"><dt>What this is</dt><dd>${p.what}</dd><dt>Why you need it</dt><dd>${p.why}</dd></dl>
    <p class="wz-links">${p.links}</p>
    <ol class="wz-how">${p.how.map((x) => `<li>${x}</li>`).join("")}</ol>
    ${p.fields?.(s) || ""}`,
});

const checklist = (list: Part[]): Step => ({
  id: "checklist", title: "Checklist",
  body: (s) => `${list.map((p) => warning(p.warn)).join("")}<ol class="wz-list">${list.map((p) => `<li><b>${p.title}</b><p>${p.short}</p><p class="wz-links">${p.links}</p>${p.fields?.(s) || ""}</li>`).join("")}</ol>`,
  next: async (d, s) => {
    for (const p of list) if (p.next && !await p.next(d, s)) return false;
    return true;
  },
});

/**
 * The steps before signing in, for what `use` needs. With a client already saved,
 * setting it up again isn't needed: only what this adds, unless `all`.
 */
export function googleSteps(use: Use, s: SyncStatus, all: boolean, mode: Mode): Step[] {
  const setup = all || !s.configured;
  const list = parts(use).filter((p) => setup || !p.setupOnly);
  if (mode === "quick") return [checklist(list)];
  return [...(setup ? [intro(use)] : []), ...list.map(guidedStep)];
}
