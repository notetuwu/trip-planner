// "Sync" on a trip in Your trips: which Drive folders it syncs to, and (for the person who shared it) whether others may
// change it or only view it.
import type { SyncStatus, TripShare } from "../../../shared/types";
import { $$, api, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { save, state } from "../core/state";
import { isOwner, openSyncSettings, ownerName, setSyncStatus, syncStatus } from "./sync-client";

let dialog: HTMLDialogElement | null = null;

function el() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "keys-dialog sync-dialog";
  document.body.append(dialog);
  return dialog;
}

/** Opens the panel for a saved trip; `done` runs after a change (to redraw Your trips). */
export function openSyncPanel(name: string, done: () => void) {
  const d = el(), s = syncStatus;
  const info = s?.trips[name];
  const share = info?.share || (state.saveName === name ? state.sync : undefined) || null;
  const mine = isOwner(share), canEdit = info ? info.canEdit : mine || share?.mode !== "view";
  let mode: "edit" | "view" = share?.mode || "edit";
  const ticked = new Set(info?.folders || []);
  const head = `<form method="dialog" class="keys-close"><button class="icon-btn" title="Close">${icon("x")}</button></form>
    <h2>Sync “${esc(name)}”</h2>`;

  const body = (): string => {
    if (!s) return `<p class="hint">Syncing is set up on the computer the planner runs on.</p>`;
    if (!s.configured) return `<p>Set up Google sign-in once to sync trips (Settings → Sync has a step-by-step guide).</p><button type="button" class="btn solid" data-settings>${icon("settings")} Open Settings → Sync</button>`;
    if (!s.signedIn) return `<p>Sign in with Google first. Then add the Drive folders to sync with.</p><button type="button" class="btn solid" data-settings>${icon("settings")} Open Settings → Sync</button>`;
    if (!s.folders.length) return `<p>Add a Drive folder to sync with first: one of your own, or one a friend shared with you.</p><button type="button" class="btn solid" data-settings>${icon("settings")} Open Settings → Sync</button>`;
    const rows = s.folders.map((f) => {
      const on = ticked.has(f.id), can = on || (canEdit && f.canWrite);
      const why = on ? "" : !f.canWrite ? "you can only view this folder in Drive" : !canEdit ? "this trip is view only for you" : "";
      return `<label class="sync-folder${can ? "" : " off"}"><input type="checkbox" data-folder="${esc(f.id)}"${on ? " checked" : ""}${can ? "" : " disabled"}>
        <span><b>${esc(f.label)}</b>${f.name && f.name !== f.label ? ` <span class="hint">(${esc(f.name)} in Drive)</span>` : ""}${why ? `<span class="hint">${esc(why)}</span>` : ""}</span></label>`;
    }).join("");
    const who = share && !mine
      ? `<p class="hint">${icon("users")} Shared by <b>${esc(ownerName(share))}</b>: ${share.mode === "view" ? "view only. Changes you make here stay on this computer and are replaced when they update it; make your own copy to change it." : "everyone with it can change it."}</p>`
      : `<div class="set-row"><div><b>Others can</b><div class="hint">Who has the trip from a folder. You can always change it.</div></div>
          <div class="segs"><button type="button" class="seg${mode === "edit" ? " on" : ""}" data-mode="edit">Edit</button><button type="button" class="seg${mode === "view" ? " on" : ""}" data-mode="view">Only view</button></div></div>`;
    return `<p class="hint">Every save also goes to the ticked folders, and changes from there come back. Who can see a folder is set in Drive (Share).</p>
      <div class="sync-folders">${rows}</div>
      ${who}
      ${info?.error ? `<p class="error-text">${icon("warn")} ${esc(info.error)}</p>` : ""}
      <p class="hint">Unticking a folder stops syncing there; the trip stays in that folder in Drive. ${!mine ? "" : "“Only view” is kept by the app, not by Drive: for a real lock, give people view access to the folder in Drive."}</p>
      <div class="sync-acts"><button type="button" class="btn solid" data-apply>${icon("check")} Done</button></div>`;
  };

  const draw = () => {
    d.innerHTML = head + `<div class="sync-body">${body()}</div>`;
    d.querySelector<HTMLButtonElement>("[data-settings]")?.addEventListener("click", () => { d.close(); openSyncSettings(); });
    $$<HTMLInputElement>("[data-folder]", d).forEach((c) => { c.onchange = () => { if (c.checked) ticked.add(c.dataset.folder!); else ticked.delete(c.dataset.folder!); }; });
    $$<HTMLButtonElement>("[data-mode]", d).forEach((b) => { b.onclick = () => { mode = b.dataset.mode as "edit" | "view"; draw(); }; });
    d.querySelector<HTMLButtonElement>("[data-apply]")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      try {
        const r = await api<{ sync: TripShare | null; status: SyncStatus }>("/api/sync/trip", { method: "POST", body: JSON.stringify({ name, folders: [...ticked], ...(mine ? { mode } : {}) }) });
        // The trip on screen gets its share too, so its next save keeps it.
        if (state.saveName === name && r.sync) { state.sync = r.sync; save(); }
        setSyncStatus(r.status);
        toast(ticked.size ? `“${name}” syncs with ${ticked.size} folder${ticked.size === 1 ? "" : "s"}` : `“${name}” doesn't sync anymore`);
        d.close();
        done();
      } catch (err) { toast((err as Error).message); btn.disabled = false; }
    });
  };
  draw();
  if (!d.open) d.showModal();
}
