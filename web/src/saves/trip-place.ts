// Where in a folder with a folder per trip a newly added trip goes: a folder browser that stays inside that sync folder.
// Its top shows the trips' folders (Drive: limited or not), each can be opened to see what's in it and where the trip's
// file would land. Folders the trip can't go into (no access, view only, or without the copy that's already there) aren't
// listed. Folders further in can be looked into, but a trip only goes into a trip's folder, since that's as far as
// trips are looked for. Nothing is chosen
// by itself for the top: saving loose there is a row of its own. A new folder is only made when the sync panel is done.
import type { FolderAccess, SyncFolder, SyncPlaces } from "../../../shared/types";
import { $$, api, closeOnBackdrop, esc } from "../core/dom";
import { askText } from "../core/ask";
import { manageAccess } from "../core/folder-access";
import { icon } from "../core/icons";

/** value: "" (not chosen), "file:<id>" (the copy already there), "sub:<folder id>", "new" or "top". */
export interface Choice { value: string; newName: string; limit: boolean }
export const isDrive = (id: string) => !id.startsWith("local:") && !id.startsWith("dropbox:");

/** The folder a choice puts the trip in, when it's there already (not a new one, or nothing chosen). */
export function targetOf(f: SyncFolder, data: SyncPlaces, c: Choice): { id: string; name: string } | null {
  if (c.value === "top") return { id: f.id, name: f.label };
  if (c.value.startsWith("sub:")) { const x = data.folders.find((y) => `sub:${y.id}` === c.value); return x ? { id: x.id, name: x.name } : null; }
  const m = data.matches.find((y) => `file:${y.fileId}` === c.value);
  return m ? { id: m.subId || f.id, name: m.sub || f.label } : null;
}

/** Whether a choice leaves the trip open to everyone on the top folder. */
function openToAll(f: SyncFolder, data: SyncPlaces, c: Choice) {
  if (c.value === "top") return true;
  if (c.value === "new") return isDrive(f.id) && !c.limit;
  const m = data.matches.find((y) => `file:${y.fileId}` === c.value);
  if (m && !m.subId) return true;
  const at = targetOf(f, data, c);
  return data.folders.some((x) => x.id === at?.id && x.limited === false);
}

/** Who can open Drive folders, asked once each; `changed` redraws when an answer arrives. */
export function audience(changed: () => void) {
  const known = new Map<string, FolderAccess | string | null>();
  return {
    forget: () => known.clear(),
    text(id: string) {
      if (!known.has(id)) {
        known.set(id, null);
        api<FolderAccess>(`/api/sync/access?id=${encodeURIComponent(id)}`).then((a) => known.set(id, a), (e) => known.set(id, (e as Error).message)).then(changed);
      }
      const a = known.get(id);
      if (a == null) return "Looking who can open it…";
      if (typeof a === "string") return esc(a);
      if (!a.people) return "Google doesn't show this account who can open it.";
      const names = a.people.filter((x) => !x.shutOut).map((x) => (x.type === "anyone" ? "anyone with the link" : x.type === "domain" ? `everyone at ${x.domain}` : x.me ? "you" : x.name));
      return `Can open it: <b>${esc(names.join(", ") || "nobody listed")}</b>`;
    },
  };
}

/** What a choice means for who sees the trip: the warning, and who can open the place. */
export function accessHtml(f: SyncFolder, data: SyncPlaces, c: Choice, who: ReturnType<typeof audience>) {
  if (!c.value) return "";
  const warn = openToAll(f, data, c) ? `<p class="tp-warn">${icon("warn")} Everyone who can open “${esc(f.label)}” can open this trip.</p>` : "";
  if (!isDrive(f.id)) return `${warn}<p class="tp-who">Who can open it is set where the folder is shared.</p>`;
  if (c.value === "new") return c.limit ? `<p class="tp-who">Only people you add can open it. You'll add them right after saving.</p>` : warn;
  const at = targetOf(f, data, c);
  return at ? `${warn}<p class="tp-who">${who.text(at.id)}</p>` : warn;
}

interface Item { id: string; name: string; folder: boolean; kind?: string; noAccess?: boolean }

/** Opens the browser; resolves with the choice, or null when closed. `reload` reads the places again (after access
 *  changed). */
export function pickTripPlace(o: { folder: SyncFolder; trip: string; data: SyncPlaces; choice: Choice; reload: () => Promise<SyncPlaces> }): Promise<Choice | null> {
  return new Promise((resolve) => {
    const f = o.folder, drive = isDrive(f.id);
    let data = o.data;
    const c: Choice = { ...o.choice };
    /** The folder looked into ("" the sync folder itself). */
    let inside = "";
    /** Folders further in than that, only to look. */
    let deeper: { id: string; name: string }[] = [];
    const listings = new Map<string, Item[] | string | null>();
    let done = false;
    const d = document.createElement("dialog");
    d.className = "keys-dialog drive-picker trip-place";
    document.body.append(d);
    closeOnBackdrop(d);
    const finish = (v: Choice | null) => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    d.addEventListener("close", () => finish(null));
    const redraw = () => { if (!done) draw(); };
    const who = audience(redraw);

    /** What's in a folder (for the top, only its files are used: the folders come with the places). */
    const listing = (id: string) => {
      if (!listings.has(id)) {
        listings.set(id, null);
        const url = id.startsWith("local:") ? `/api/fs/list?path=${encodeURIComponent(id.slice(6))}`
          : `/api/sync/${id.startsWith("dropbox:") ? "dropbox/" : ""}browse?in=${encodeURIComponent(id)}`;
        api<{ entries: Item[] }>(url).then((r) => listings.set(id, r.entries), (e) => listings.set(id, (e as Error).message)).then(redraw);
      }
      return listings.get(id)!;
    };

    /** Something in a folder: a folder further in can be opened, a file is only shown, a folder that isn't open to this
     *  account not at all. (This computer's list gives paths: they get their "local:" back.) */
    const fileRow = (x: Item) => (x.noAccess ? "" : x.folder
      ? `<div class="dp-row tp-look" tabindex="0" data-deeper="${esc(f.id.startsWith("local:") ? `local:${x.id}` : x.id)}" data-name="${esc(x.name)}"><span class="dp-name">${icon("folder")}<span>${esc(x.name)}</span></span><span><button type="button" class="dp-go" data-go title="Look inside">${icon("chevronDown")}</button></span></div>`
      : `<div class="dp-row file"><span class="dp-name">${icon(x.kind === "image" ? "image" : "file")}<span>${esc(x.name)}</span></span><span></span></div>`);
    /** Where the file would be written. */
    const landing = (name: string) => `<div class="dp-row tp-landing"><span class="dp-name">${icon("plus")}<span>${esc(name)}</span></span><span><span class="tp-tag">Saved here</span></span></div>`;
    const tag = (limited?: boolean) => (!drive || limited === undefined ? "" : limited ? `<span class="tp-tag">${icon("lock")} Limited</span>` : `<span class="tp-tag open">${icon("users")} Not limited</span>`);
    const pickRow = (o: { value: string; ico: Parameters<typeof icon>[0]; name: string; tags?: string; open?: string }) =>
      `<div class="dp-row${c.value === o.value ? " sel" : ""}" role="option" aria-selected="${c.value === o.value}" tabindex="0" data-value="${esc(o.value)}"${o.open ? ` data-open="${esc(o.open)}"` : ""}>
        <span class="dp-name">${icon(o.ico)}<span>${esc(o.name)}</span></span><span>${o.tags || ""}${o.open ? `<button type="button" class="dp-go" data-go title="Look inside">${icon("chevronDown")}</button>` : ""}</span></div>`;

    /** The copy of this trip in a folder ("" the top), when there is one. */
    const matchIn = (subId: string) => data.matches.find((m) => m.subId === subId);

    const rows = () => {
      const matched = data.matches.length > 0;
      if (deeper.length) {
        const list = listing(deeper[deeper.length - 1].id);
        return Array.isArray(list) ? list.map(fileRow).join("") || `<p class="dp-msg hint">This folder is empty.</p>`
          : `<p class="dp-msg ${list ? "error-text" : "hint"}">${esc(list || "Loading…")}</p>`;
      }
      if (inside) {
        const x = data.folders.find((y) => y.id === inside), list = listing(inside), m = matchIn(inside);
        const files = Array.isArray(list) ? list.map((e) => (m && e.name === m.name ? pickRow({ value: `file:${m.fileId}`, ico: "file", name: e.name, tags: `<span class="tp-tag">This trip</span>` }) : fileRow(e))).join("")
          : `<p class="dp-msg ${list ? "error-text" : "hint"}">${esc(list || "Loading…")}</p>`;
        // (A folder that holds another trip already: this one goes in under its own name.)
        return files + (!matched && x?.canWrite && Array.isArray(list) ? landing(x.trips.length ? `${o.trip}.trip.json` : "trip.json") : "");
      }
      const made = c.value === "new" ? pickRow({ value: "new", ico: "folder", name: c.newName, tags: `<span class="tp-tag">New</span>${drive ? tag(c.limit) : ""}` }) : "";
      // With a copy of the trip there already, only a copy can be chosen.
      const folders = data.folders.filter((x) => (matched ? !!matchIn(x.id) : x.canWrite && !x.noAccess)).map((x) => {
        const m = matchIn(x.id);
        return pickRow({
          value: m ? `file:${m.fileId}` : `sub:${x.id}`, ico: "folder", name: x.name, open: x.id,
          tags: `${m ? `<span class="tp-tag">Has this trip</span>` : x.trips.length ? `<span class="tp-tag">Has a trip</span>` : ""}${tag(x.limited)}`,
        });
      }).join("");
      const list = listing(f.id), m = matchIn("");
      const files = Array.isArray(list) ? list.filter((e) => !e.folder && e.name !== m?.name).map(fileRow).join("") : "";

      const loose = m ? pickRow({ value: `file:${m.fileId}`, ico: "file", name: m.name, tags: `<span class="tp-tag">This trip</span>` })
        : !matched && data.topWrite ? `<div class="tp-loose">${pickRow({ value: "top", ico: "file", name: `Save loose in “${f.label}”, in no trip's folder` })}</div>` : "";
      return (made + folders || (matched ? "" : `<p class="dp-msg hint">There's no folder in it you can save to.</p>`)) + files + loose;
    };

    const draw = () => {
      const scroll = d.querySelector(".dp-list")?.scrollTop || 0;
      const focus = d.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.value : undefined;
      const x = data.folders.find((y) => y.id === inside), looking = deeper.length > 0, at = looking ? null : targetOf(f, data, c);
      // The path down to here; the last one is where we are.
      const crumbs = [f.label, ...(x ? [x.name, ...deeper.map((y) => y.name)] : [])];
      d.innerHTML = `<div class="dp-head"><div><h2>Where should “${esc(o.trip)}” go?</h2><p class="hint">${data.matches.length ? "This trip is already in here. Choose the copy to sync with." : "Choose the trip's folder."}</p></div>
          <button type="button" class="icon-btn" data-cancel title="Close">${icon("x")}</button></div>
        <div class="dp-bar">
          <button type="button" class="icon-btn" data-up title="Up one folder"${inside ? "" : " disabled"}>${icon("arrowUp")}</button>
          <div class="dp-path">${crumbs.map((n, i) => `<button type="button" data-crumb="${i}"${i === crumbs.length - 1 ? ' class="on"' : ""}>${i ? "" : icon(drive ? "drive" : f.id.startsWith("local:") ? "monitor" : "box")}${esc(n)}</button>`).join(`<span class="dp-sep">›</span>`)}</div>
          ${!inside && !data.matches.length && data.topWrite ? `<button type="button" class="btn" data-new>${icon("plus")} New folder</button>` : ""}
        </div>
        <div class="dp-list" role="listbox">${rows()}</div>
        ${looking ? `<div class="tp-info"><p class="tp-who">Only to look: a trip is saved in its trip's folder, not further in.</p></div>` : c.value ? `<div class="tp-info">${c.value === "new" && drive ? `<label class="tp-limit"><input type="checkbox" data-limit${c.limit ? " checked" : ""}> Limit access to people you add</label>` : ""}${accessHtml(f, data, c, who)}</div>` : ""}
        <div class="dp-foot">${drive && at ? `<button type="button" class="btn" data-access>${icon("users")} Access</button>` : "<span></span>"}
          <span class="dp-acts"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn solid" data-choose${c.value && !looking ? "" : " disabled"}>${icon("check")} Save here</button></span></div>`;
      d.querySelector(".dp-list")!.scrollTop = scroll;

      const open = (id: string) => {
        inside = id;
        // Looking into a folder that can take the trip chooses it.
        const m = matchIn(id), y = data.folders.find((z) => z.id === id);
        if (m) c.value = `file:${m.fileId}`; else if (!data.matches.length && y?.canWrite) c.value = `sub:${id}`;
        draw();
        d.querySelector(".dp-list")!.scrollTop = 0;
      };
      $$<HTMLElement>(".dp-row[data-value], .dp-row[data-open]", d).forEach((r) => {
        const select = () => { if (r.dataset.value && c.value !== r.dataset.value) { c.value = r.dataset.value; draw(); } };
        r.onclick = (e) => { if (r.dataset.open && (e.target as HTMLElement).closest("[data-go]")) open(r.dataset.open); else select(); };
        // (The row is drawn again on the first click, so a double-click is told by the click's count.)
        r.addEventListener("mousedown", (e) => { if (e.detail === 2 && r.dataset.open) { e.preventDefault(); open(r.dataset.open); } });
        r.onkeydown = (e) => {
          if (e.target !== r) return;
          if (e.key === " ") { e.preventDefault(); select(); }
          else if (e.key === "Enter") { e.preventDefault(); if (r.dataset.open) open(r.dataset.open); else select(); }
        };
        if (focus && r.dataset.value === focus) r.focus({ preventScroll: true });
      });
      /** Back to the first `n` steps of the path (1: the sync folder itself). */
      const back = (n: number) => { if (n >= crumbs.length) return; if (n < 2) inside = ""; deeper = deeper.slice(0, Math.max(0, n - 2)); draw(); };
      d.querySelector<HTMLButtonElement>("[data-up]")!.onclick = () => back(crumbs.length - 1);
      $$<HTMLButtonElement>("[data-crumb]", d).forEach((b) => { b.onclick = () => back(+b.dataset.crumb! + 1); });
      $$<HTMLElement>("[data-deeper]", d).forEach((r) => {
        const look = () => { deeper.push({ id: r.dataset.deeper!, name: r.dataset.name! }); draw(); d.querySelector(".dp-list")!.scrollTop = 0; };
        r.onclick = look;
        r.onkeydown = (e) => { if (e.target === r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); look(); } };
      });
      $$<HTMLButtonElement>("[data-cancel]", d).forEach((b) => { b.onclick = () => finish(null); });
      d.querySelector<HTMLButtonElement>("[data-choose]")!.onclick = () => finish(c);
      d.querySelector<HTMLInputElement>("[data-limit]")?.addEventListener("change", (e) => { c.limit = (e.target as HTMLInputElement).checked; draw(); });
      d.querySelector<HTMLButtonElement>("[data-new]")?.addEventListener("click", async () => {
        const made = await askText({
          title: "New folder", text: `In “${f.label}”. It's made when you press Done.`, value: c.newName, ok: "Add", required: true,
          validate: (v) => (data.folders.some((y) => y.name.trim().toLowerCase() === v.toLowerCase()) ? "There's already a folder of that name." : ""),
        });
        if (!made) return;
        c.newName = made; c.value = "new"; draw();
        d.querySelector(".dp-list")!.scrollTop = 0;
      });
      d.querySelector<HTMLButtonElement>("[data-access]")?.addEventListener("click", async () => {
        if (!at || !await manageAccess(at.id, at.name)) return;
        who.forget();
        try { data = await o.reload(); } catch { /* the list stays as it was */ }
        redraw();
      });
    };
    d.showModal();
    draw();
  });
}
