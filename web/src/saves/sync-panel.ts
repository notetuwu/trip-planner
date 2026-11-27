// "Sync" on a trip in Your trips: which Drive folders it syncs to, and (for the person who shared it) whether others may
// change it or only view it. A folder with a folder per trip also asks where in it the trip goes (trip-place.ts),
// showing who can open that place.
import type { SyncFolder, SyncPlace, SyncPlaces, SyncStatus, TripShare } from "../../../shared/types";
import { $$, api, closeOnBackdrop, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { manageAccess } from "../core/folder-access";
import { type Choice, accessHtml, audience, isDrive, pickTripPlace } from "./trip-place";
import { save, state } from "../core/state";
import { isOwner, openSyncSettings, ownerName, setSyncStatus, syncStatus } from "./sync-client";

let dialog: HTMLDialogElement | null = null;
/** Counts the openings, so a slow answer for one doesn't draw over the next. */
let opening = 0;

/** Where in one folder the trip goes, and the places there are. */
interface Asked extends Choice { data?: SyncPlaces; error?: string }

function el() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "keys-dialog sync-dialog";
  closeOnBackdrop(dialog);
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
  // The folders it syncs to are ticked; when there are none, those that already hold its file (a folder added again,
  // files moved around), so Done connects it.
  const found = !info?.folders.length && canEdit ? info?.found || [] : [];
  const ticked = new Set([...(info?.folders || []), ...found]);
  const mine_ = ++opening, choices = new Map<string, Asked>();
  const redraw = () => { if (mine_ === opening && d.open) draw(); };
  const who = audience(() => redraw());
  /** Folders being added that need a place. */
  const asking = () => (canEdit ? (s?.folders || []).filter((f) => f.discover && ticked.has(f.id) && !info?.folders.includes(f.id)) : []);

  const read = (f: SyncFolder) => api<SyncPlaces>(`/api/sync/places?folder=${encodeURIComponent(f.id)}&name=${encodeURIComponent(name)}`);
  /** Reads a folder's places, then opens the browser on them when there's still a choice to make. */
  const load = async (f: SyncFolder) => {
    const c = choices.get(f.id) || { value: "", newName: name, limit: true };
    choices.set(f.id, c);
    c.data = undefined; c.error = undefined;
    try {
      c.data = await read(f);
      const { matches, folders } = c.data, same = folders.find((x) => x.canWrite && x.name.trim().toLowerCase() === name.trim().toLowerCase());
      // Chosen for you only when there's no doubt: the one copy there is, or the folder of exactly the trip's name.
      c.value = matches.length === 1 ? `file:${matches[0].fileId}` : !matches.length && same ? `sub:${same.id}` : "";
    } catch (e) { c.error = (e as Error).message; }
    redraw();
    if (c.data && !c.value && mine_ === opening && d.open && choices.get(f.id) === c) browse(f);
  };
  const browse = async (f: SyncFolder) => {
    const c = choices.get(f.id);
    if (!c?.data) return;
    const picked = await pickTripPlace({ folder: f, trip: name, data: c.data, choice: c, reload: async () => (c.data = await read(f)) });
    if (picked) Object.assign(c, picked);
    who.forget();
    redraw();
  };

  /** In a folder's card: where the trip will go, and the button to choose it. */
  const placeHtml = (f: SyncFolder) => {
    const c = choices.get(f.id);
    if (!c) { load(f); return placeHtml(f); }
    const data = c.data;
    if (!data) return `<div class="sync-place">${c.error ? `<p class="error-text">${icon("warn")} ${esc(c.error)}</p><button type="button" class="link-btn" data-retry="${esc(f.id)}">Try again</button>` : `<p class="hint">Looking in the folder…</p>`}</div>`;
    const m = data.matches.find((x) => c.value === `file:${x.fileId}`);
    const folder = c.value === "new" ? c.newName : c.value.startsWith("sub:") ? data.folders.find((x) => c.value === `sub:${x.id}`)?.name || "" : m?.sub || "";
    const path = [f.label, folder].filter(Boolean).map(esc).join(` <span class="dp-sep">›</span> `);
    return `<div class="sync-place">
      <div class="sync-where">${c.value ? `${icon("folder")}<span><b>${path}</b>${c.value === "new" ? ` <span class="tp-tag">New${c.limit && isDrive(f.id) ? " · limited" : ""}</span>` : ""}</span>` : `<span class="hint">No folder chosen yet.</span>`}
        <button type="button" class="btn${c.value ? "" : " solid"}" data-browse="${esc(f.id)}">${c.value ? "Change…" : "Choose folder…"}</button></div>
      ${accessHtml(f, data, c, who)}
    </div>`;
  };

  /** What's chosen, as the server takes it; null while a choice is missing. */
  const places = (): Record<string, SyncPlace> | null => {
    const out: Record<string, SyncPlace> = {};
    for (const f of asking()) {
      const c = choices.get(f.id), v = c?.value || "";
      if (!c?.data || !v) return null;
      out[f.id] = v === "new" ? { create: c.newName.trim(), limit: c.limit && isDrive(f.id) } : v === "top" ? { top: true } : v.startsWith("sub:") ? { sub: v.slice(4) } : { file: v.slice(5) };
    }
    return out;
  };
  const head = `<form method="dialog" class="keys-close"><button class="icon-btn" title="Close">${icon("x")}</button></form>
    <h2>Sync “${esc(name)}”</h2>`;

  const body = (): string => {
    if (!s) return `<p class="hint">Syncing is set up on the computer the planner runs on.</p>`;
    if (!s.folders.length) return `<p>Add a folder to sync with first: in Google Drive, one a friend shared with you, or one on this computer (a network drive, or your OneDrive or Dropbox folder).</p><button type="button" class="btn solid" data-settings>${icon("settings")} Open Settings → Sync</button>`;
    const rows = s.folders.map((f) => {
      // With a folder per trip, a trip's folder may be editable where the top one isn't.
      const on = ticked.has(f.id), writable = f.canWrite || !!f.discover, can = on || (canEdit && writable);
      const why = found.includes(f.id) ? "this trip is already in it: press Done to sync with it" : on ? "" : !writable ? "you can only view this folder" : !canEdit ? "this trip is view only for you" : f.error || "";
      const place = asking().includes(f) ? placeHtml(f) : "";
      return `<div class="sync-pick${place ? " asking" : ""}"><label class="sync-folder${can ? "" : " off"}"><input type="checkbox" data-folder="${esc(f.id)}"${on ? " checked" : ""}${can ? "" : " disabled"}>
        <span><b>${icon(f.id.startsWith("local:") ? "monitor" : f.id.startsWith("dropbox:") ? "box" : "drive")} ${esc(f.label)}</b>${f.id.startsWith("local:") ? ` <span class="hint">(${esc(f.kind || "on this computer")})</span>` : f.name && f.name !== f.label ? ` <span class="hint">(${esc(f.name)} in ${f.id.startsWith("dropbox:") ? "Dropbox" : "Drive"})</span>` : ""}${why ? `<span class="hint">${esc(why)}</span>` : ""}</span></label>${place}</div>`;
    }).join("");
    const who = share && !mine
      ? `<p class="hint">${icon("users")} Shared by <b>${esc(ownerName(share))}</b>: ${share.mode === "view" ? "view only. Changes you make here stay on this computer and are replaced when they update it; make your own copy to change it." : "everyone with it can change it."}</p>`
      : `<div class="set-row"><div><b>Others can</b><div class="hint">Who has the trip from a folder. You can always change it.</div></div>
          <div class="segs"><button type="button" class="seg${mode === "edit" ? " on" : ""}" data-mode="edit">Edit</button><button type="button" class="seg${mode === "view" ? " on" : ""}" data-mode="view">Only view</button></div></div>`;
    return `<p class="hint">Every save also goes to the ticked folders, and changes from there come back. Who can see a folder is set in Drive (Share).</p>
      <div class="sync-folders">${rows}</div>
      ${who}
      ${info?.error ? `<p class="error-text">${icon("warn")} ${esc(info.error)}</p>` : ""}
      <p class="hint">Unticking a folder stops syncing there; the trip stays in that folder in Drive. ${!mine ? "" : "“Only view” is kept by the app, not by the folder: for a real lock, give people view access to the folder itself."}</p>
      <div class="sync-acts">${places() ? "" : `<span class="hint">Choose where the trip goes first.</span>`}<button type="button" class="btn solid" data-apply${places() ? "" : " disabled"}>${icon("check")} Done</button></div>`;
  };

  const draw = () => {
    d.innerHTML = head + `<div class="sync-body">${body()}</div>`;
    d.querySelector<HTMLButtonElement>("[data-settings]")?.addEventListener("click", () => { d.close(); openSyncSettings(); });
    $$<HTMLInputElement>("[data-folder]", d).forEach((c) => { c.onchange = () => { if (c.checked) ticked.add(c.dataset.folder!); else { ticked.delete(c.dataset.folder!); choices.delete(c.dataset.folder!); } draw(); }; });
    $$<HTMLButtonElement>("[data-browse]", d).forEach((x) => { x.onclick = () => browse(s!.folders.find((f) => f.id === x.dataset.browse)!); });
    $$<HTMLButtonElement>("[data-retry]", d).forEach((x) => { x.onclick = () => { load(s!.folders.find((f) => f.id === x.dataset.retry)!); draw(); }; });
    $$<HTMLButtonElement>("[data-mode]", d).forEach((b) => { b.onclick = () => { mode = b.dataset.mode as "edit" | "view"; draw(); }; });
    d.querySelector<HTMLButtonElement>("[data-apply]")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLButtonElement, where = places();
      if (!where) return;
      btn.disabled = true;
      try {
        const r = await api<{ sync: TripShare | null; created: { id: string; name: string }[]; status: SyncStatus }>("/api/sync/trip", { method: "POST", body: JSON.stringify({ name, folders: [...ticked], places: where, ...(mine ? { mode } : {}) }) });
        // The trip on screen gets its share too, so its next save keeps it.
        if (state.saveName === name && r.sync) { state.sync = r.sync; save(); }
        setSyncStatus(r.status);
        toast(ticked.size ? `“${name}” syncs with ${ticked.size} folder${ticked.size === 1 ? "" : "s"}` : `“${name}” doesn't sync anymore`);
        d.close();
        done();
        // A new limited folder has nobody on it yet: add the trip's people.
        for (const made of r.created) await manageAccess(made.id, made.name);
      } catch (err) { toast((err as Error).message); btn.disabled = false; }
    });
  };
  draw();
  if (!d.open) d.showModal();
}
