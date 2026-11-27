// Settings → Photos: where the map's photos can come from and what each place needs. A folder on this computer needs
// nothing; Google Drive needs signing in, or, for folders shared as "Anyone with the link" only, a free API key (offered
// while Google isn't connected); Dropbox needs signing in. The folders themselves are chosen in the Photos window.
import type { SyncStatus } from "../../../shared/types";
import { esc } from "../core/dom";
import { icon } from "../core/icons";
import { syncStatus } from "../saves/sync-client";
import { openPhotosView } from "../itinerary/photos-view";
import { openConnect } from "./connect-wizard";

/** `keyField`: the Google API key's field (drawn and saved like the other service keys). */
export function photosHtml(keyField: string, s: SyncStatus | null = syncStatus) {
  const drive = !!s?.signedIn && s.drive !== false, dbx = s?.dropbox;
  return `<h3>Photos</h3>
    <p class="hint set-intro">Photos and videos show on the map where they were taken, and in a gallery by day. Choose their folders in the Photos window.</p>
    <div class="set-card">
      <div class="set-row"><div><b>Photo folders</b><div class="hint">Add or remove folders, and see the photos.</div></div>
        <button type="button" class="btn solid" data-photos>${icon("images")} Open Photos</button></div>
    </div>
    <div class="set-card">
      <b class="card-title">Where photos can come from</b>
      <div class="set-row"><div><b>${icon("monitor")} This computer</b><div class="hint">Ready, nothing to set up.</div></div><span class="fit ok">${icon("check")} Ready</span></div>
      <div class="set-row"><div><b>${icon("drive")} Google Drive</b><div class="hint">${!s ? "Checking…" : drive ? `Connected${s.name || s.email ? ` as ${esc(s.name || s.email)}` : ""}: your folders and ones shared with you.` : "Connect Google for your own folders and ones shared with you."}</div></div>
        ${drive ? `<span class="fit ok">${icon("check")} Connected</span>` : `<button type="button" class="btn" data-connect-drive>Connect</button>`}</div>
      ${drive && !/is-set/.test(keyField) ? "" : `<details class="acc-manage photos-key"><summary>${drive ? "Your Google API key (not needed while Google is connected)"
        : "Don’t need to sync trips with Drive? For folders shared as “Anyone with the link”, an API key is enough"}</summary><div class="kf-list kf-svc">${keyField}</div></details>`}
      <div class="set-row"><div><b>${icon("box")} Dropbox</b><div class="hint">${!s ? "Checking…" : dbx?.signedIn ? `Connected${dbx.name || dbx.email ? ` as ${esc(dbx.name || dbx.email)}` : ""}.` : "Connect Dropbox to use its folders."} Where and when each photo was taken is read from the file itself, so a big folder takes a while to appear on the map the first time.</div></div>
        ${dbx?.signedIn ? `<span class="fit ok">${icon("check")} Connected</span>` : `<button type="button" class="btn" data-connect-dropbox>Connect</button>`}</div>
    </div>`;
}

/** The API key's part stays open while the tab redraws. */
let keyOpen = false;

export function renderPhotos(main: HTMLElement, keyField: string, again: () => void) {
  main.innerHTML = photosHtml(keyField);
  const details = main.querySelector<HTMLDetailsElement>(".photos-key");
  if (details) {
    details.open = keyOpen;
    details.addEventListener("toggle", () => { keyOpen = details.open; });
  }
  main.querySelector<HTMLButtonElement>("[data-connect-drive]")?.addEventListener("click", () => openConnect("drive", again));
  main.querySelector<HTMLButtonElement>("[data-connect-dropbox]")?.addEventListener("click", () => openConnect("dropbox", again));
  main.querySelector<HTMLButtonElement>("[data-photos]")!.onclick = () => {
    document.querySelector<HTMLDialogElement>("#settingsDialog")?.close();
    openPhotosView();
  };
}
