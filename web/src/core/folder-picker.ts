// The app's folder browser, for photo folders and sync folders: like the system's own file browser, but with every place
// a folder can be in one list on the left. This computer (home, Desktop, Pictures…, folders OneDrive, Dropbox or iCloud
// keep in step here, the drives, network drives included) and Google Drive (My Drive, Shared with me, shared drives;
// with the sign-in of Settings → Sync). The path along the top with Back and Up, what's in the folder as a list (folders
// first, files greyed). Click selects a folder, double-click (or its arrow, or Enter) opens it. "New folder" makes one
// where you are. "Paste a link or path" takes a Google Drive link or a path and works out which it is.
import { $$, api, closeOnBackdrop, esc, toast } from "./dom";
import { askText, tell } from "./ask";
import { icon } from "./icons";
import { loadSyncStatus } from "../saves/sync-client";
import { classifyLink } from "../../../shared/folder-link";

export { classifyLink };

type Provider = "local" | "drive" | "dropbox";
interface Entry { id: string; name: string; folder: boolean; canWrite: boolean; owner?: string; modified?: string; size?: number; kind?: "image" | "video" | "trip" | "file"; place?: string }
/** A folder chosen: where it is, its id (a Drive id, or the path), and what the app stores for it ("local:<path>", or
 *  the Drive link). */
export interface PickedFolder { provider: Provider; id: string; name: string; canWrite: boolean; link: string }
interface Crumb { id: string; name: string; canWrite: boolean }
/** Where we are: in which place, and the folders down to here ("" for a place's own list: the drives, Shared with me…). */
interface Spot { provider: Provider; top: string; trail: Crumb[] }

const DRIVE_TOPS = [
  { id: "root", name: "My Drive", ic: "drive", hint: "Your own folders" },
  { id: "shared", name: "Shared with me", ic: "users", hint: "Folders others shared with you" },
  { id: "drives", name: "Shared drives", ic: "globe", hint: "Your team's shared drives" },
] as const;
const DROPBOX_TOPS = [
  { id: "root", name: "Dropbox", ic: "box", hint: "Your Dropbox" },
  { id: "shared", name: "Shared with me", ic: "users", hint: "Folders others shared with you in Dropbox" },
] as const;
const PLACE_ICON: Record<string, Parameters<typeof icon>[0]> = { home: "hotel", desktop: "monitor", documents: "file", pictures: "images", downloads: "download", cloud: "cloud", drive: "drive" };
const KIND_ICON = { image: "image", video: "play", trip: "file", file: "file" } as const;

const when = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
};
const size = (n?: number) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);
const driveLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** A path as the folders down to it: "C:\Users\me" → C:\, Users, me (each with its full path). */
function crumbsOf(p: string): Crumb[] {
  const win = /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\"), sep = win ? "\\" : "/";
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const out: Crumb[] = [];
  let acc = p.startsWith("\\\\") ? "\\\\" : win ? "" : "/";
  parts.forEach((part, i) => {
    acc = i === 0 ? (win && !p.startsWith("\\\\") ? `${part}\\` : `${acc}${part}`) : `${acc}${acc.endsWith(sep) ? "" : sep}${part}`;
    out.push({ id: acc, name: i === 0 && win ? part.replace(/\\$/, "") : part, canWrite: true });
  });
  return out.length ? out : [{ id: "/", name: "/", canWrite: true }];
}

/** Opens the folder browser; resolves with the folder chosen, or null when closed. */
export function pickFolder(o: { title: string; note?: string; start?: Provider; /** Where folders may come from (all by default). */ providers?: Provider[] }): Promise<PickedFolder | null> {
  const allowed = o.providers || ["local", "drive", "dropbox"];
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "keys-dialog drive-picker";
    document.body.append(d);
    closeOnBackdrop(d);
    let places: Entry[] = [], driveOk = false, dropboxOk = false;
    let spot: Spot = { provider: o.start || "local", top: o.start === "drive" ? "root" : "", trail: [] };
    let back: Spot[] = [];
    let entries: Entry[] | null = null, more = false, error = "", selected = "", done = false, seq = 0;
    const finish = (v: PickedFolder | null) => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    d.addEventListener("close", () => finish(null));

    const here = (): Crumb | null => spot.trail[spot.trail.length - 1] || null;
    const picked = (c: Crumb, provider = spot.provider): PickedFolder => ({ provider, id: c.id, name: c.name, canWrite: c.canWrite, link: provider === "local" ? `local:${c.id}` : provider === "dropbox" ? c.id : driveLink(c.id) });
    /** What Choose takes: the folder selected, else the one we're in (not a place's own list). */
    const target = (): Crumb | null => {
      const e = entries?.find((x) => x.id === selected && x.folder);
      return e ? { id: e.id, name: e.name, canWrite: e.canWrite } : here();
    };
    const go = (next: Spot, remember = true) => { if (remember) back.push(spot); spot = next; selected = ""; load(); };
    const into = (e: { id: string; name: string; canWrite: boolean }) =>
      go(spot.provider === "local" ? { provider: "local", top: "", trail: crumbsOf(e.id).map((c, i, all) => (i === all.length - 1 ? { ...c, name: e.name, canWrite: e.canWrite } : c)) }
        : { ...spot, trail: [...spot.trail, { id: e.id, name: e.name, canWrite: e.canWrite }] });

    const load = async () => {
      const mine = ++seq;
      entries = null; error = ""; more = false; drawList();
      try {
        if (spot.provider === "local") {
          const h = here();
          if (!h) entries = places;
          else { const r = await api<{ entries: Entry[]; more: boolean }>(`/api/fs/list?path=${encodeURIComponent(h.id)}`); if (mine === seq) { entries = r.entries; more = r.more; } }
        } else {
          const r = await api<{ entries: Entry[]; more: boolean }>(`/api/sync/${spot.provider === "dropbox" ? "dropbox/" : ""}browse?in=${encodeURIComponent(here()?.id || spot.top)}`);
          if (mine === seq) { entries = r.entries; more = r.more; }
        }
      } catch (e) { if (mine === seq) error = (e as Error).message; }
      if (mine === seq) drawList();
    };

    const side = () => {
      const local = places.map((p) => `<button type="button" data-place="${esc(p.id)}" title="${esc(p.id)}">${icon(PLACE_ICON[p.place || "drive"] || "folder")}<span>${esc(p.name)}</span></button>`).join("");
      const drive = driveOk ? DRIVE_TOPS.map((t) => `<button type="button" data-top="${t.id}" title="${esc(t.hint)}">${icon(t.ic)}<span>${esc(t.name)}</span></button>`).join("")
        : `<button type="button" data-signin title="Sign in with Google to use Drive (Settings → Sync)">${icon("key")}<span>Sign in…</span></button>`;
      const dropbox = dropboxOk ? DROPBOX_TOPS.map((t) => `<button type="button" data-dtop="${t.id}" title="${esc(t.hint)}">${icon(t.ic)}<span>${esc(t.name)}</span></button>`).join("")
        : `<button type="button" data-signin title="Sign in to Dropbox to use it (Settings → Sync)">${icon("key")}<span>Sign in…</span></button>`;
      return (allowed.includes("local") ? `<div class="dp-group">${icon("monitor")} This computer</div>${local}` : "")
        + (allowed.includes("drive") ? `<div class="dp-group">${icon("drive")} Google Drive</div>${drive}` : "")
        + (allowed.includes("dropbox") ? `<div class="dp-group">${icon("box")} Dropbox</div>${dropbox}` : "");
    };

    d.innerHTML = `<div class="dp-head"><div><h2>${esc(o.title)}</h2>${o.note ? `<p class="hint">${esc(o.note)}</p>` : ""}</div>
        <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div>
      <div class="dp-main">
        <nav class="dp-places"></nav>
        <div class="dp-pane">
          <div class="dp-bar">
            <button type="button" class="icon-btn" data-back title="Back">${icon("arrowLeft")}</button>
            <button type="button" class="icon-btn" data-up title="Up one folder">${icon("arrowUp")}</button>
            <div class="dp-path"></div>
            <button type="button" class="btn" data-paste title="A Google Drive link, or a folder's path on this computer or a network drive">${icon("link")} Paste</button>
            <button type="button" class="btn" data-new title="Make a new folder here">${icon("plus")} New folder</button>
          </div>
          <div class="dp-cols"><span>Name</span><span>Owner</span><span>Modified</span><span>Size</span></div>
          <div class="dp-list" tabindex="0"></div>
        </div>
      </div>
      <div class="dp-foot"><span class="dp-sel"></span><span class="dp-acts"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn solid" data-choose>${icon("check")} Choose this folder</button></span></div>`;

    const list = d.querySelector<HTMLElement>(".dp-list")!;
    const drawSide = () => {
      d.querySelector(".dp-places")!.innerHTML = side();
      $$<HTMLButtonElement>("[data-place]", d).forEach((b) => { b.onclick = () => { const p = places.find((x) => x.id === b.dataset.place)!; go({ provider: "local", top: "", trail: crumbsOf(p.id).map((c, i, all) => (i === all.length - 1 ? { ...c, name: p.name, canWrite: p.canWrite } : c)) }); }; });
      $$<HTMLButtonElement>("[data-top]", d).forEach((b) => { b.onclick = () => go({ provider: "drive", top: b.dataset.top!, trail: b.dataset.top === "root" ? [{ id: "root", name: "My Drive", canWrite: true }] : [] }); });
      $$<HTMLButtonElement>("[data-dtop]", d).forEach((b) => { b.onclick = () => go({ provider: "dropbox", top: b.dataset.dtop!, trail: b.dataset.dtop === "root" ? [{ id: "root", name: "Dropbox", canWrite: true }] : [] }); });
      $$<HTMLButtonElement>("[data-signin]", d).forEach((b) => b.addEventListener("click", () => { finish(null); document.dispatchEvent(new CustomEvent("open-settings", { detail: "sync" })); }));
    };
    const drawList = () => {
      const h = here(), local = spot.provider === "local";
      // Which place on the left is lit: the one this folder is in (the longest place path it starts with).
      const lit = local && h ? places.filter((p) => h.id.toLowerCase().startsWith(p.id.toLowerCase())).sort((a, b) => b.id.length - a.id.length)[0]?.id : "";
      $$<HTMLButtonElement>("[data-place]", d).forEach((b) => b.classList.toggle("on", b.dataset.place === lit));
      $$<HTMLButtonElement>("[data-top]", d).forEach((b) => b.classList.toggle("on", spot.provider === "drive" && spot.top === b.dataset.top));
      $$<HTMLButtonElement>("[data-dtop]", d).forEach((b) => b.classList.toggle("on", spot.provider === "dropbox" && spot.top === b.dataset.dtop));
      const tops = spot.provider === "dropbox" ? DROPBOX_TOPS : DRIVE_TOPS;
      const topName = local ? "This computer" : tops.find((t) => t.id === spot.top)?.name || "";
      const crumbs = local ? [{ id: "", name: topName, canWrite: false }, ...spot.trail] : spot.top === "root" ? spot.trail : [{ id: "", name: topName, canWrite: false }, ...spot.trail];
      d.querySelector(".dp-path")!.innerHTML = crumbs.map((x, i) => `<button type="button" data-crumb="${i}"${i === crumbs.length - 1 ? ' class="on"' : ""}>${i === 0 ? icon(local ? "monitor" : tops.find((t) => t.id === spot.top)?.ic || "drive") : ""}${esc(x.name)}</button>`).join(`<span class="dp-sep">›</span>`);
      d.querySelector<HTMLButtonElement>("[data-back]")!.disabled = !back.length;
      d.querySelector<HTMLButtonElement>("[data-up]")!.disabled = !h || (!local && spot.top === "root" && spot.trail.length === 1);
      d.querySelector<HTMLButtonElement>("[data-new]")!.disabled = !h || !h.canWrite;
      list.innerHTML = error ? `<p class="dp-msg error-text">${icon("warn")} ${esc(error)}</p>`
        : !entries ? `<p class="dp-msg hint">Loading…</p>`
        : !entries.length ? `<p class="dp-msg hint">${h ? "This folder is empty." : "Nothing here."}</p>`
        : entries.map((e) => `<div class="dp-row${e.folder ? "" : " file"}${e.id === selected ? " sel" : ""}" ${e.folder ? `data-id="${esc(e.id)}" role="option" aria-selected="${e.id === selected}"` : ""} title="${esc(local ? e.id : e.name)}">
            <span class="dp-name">${icon(e.folder ? (e.place ? PLACE_ICON[e.place] || "folder" : "folder") : KIND_ICON[e.kind || "file"])}<span>${esc(e.name)}</span>${e.folder && !e.canWrite && h ? `<span class="dp-tag">view only</span>` : ""}</span>
            <span>${esc(e.owner || (local ? "" : "me"))}</span><span>${esc(when(e.modified))}</span><span>${e.folder ? `<button type="button" class="dp-go" data-go title="Open “${esc(e.name)}”">${icon("chevronDown")}</button>` : esc(size(e.size))}</span></div>`).join("")
          + (more ? `<p class="dp-msg hint">…and more (only the first ${entries.length} are listed).</p>` : "");
      $$<HTMLElement>(".dp-row[data-id]", list).forEach((r) => {
        const open = () => into(entries!.find((x) => x.id === r.dataset.id)!);
        r.onclick = (ev) => { if ((ev.target as HTMLElement).closest("[data-go]")) return open(); select(r.dataset.id!); };
        r.ondblclick = open;
      });
      $$<HTMLButtonElement>("[data-crumb]", d).forEach((b) => {
        b.onclick = () => {
          const i = +b.dataset.crumb!;
          if (i === crumbs.length - 1) return;
          const keep = local || spot.top !== "root" ? i : i + 1; // (the first crumb is the place's own list, except in My Drive)
          go({ ...spot, trail: spot.trail.slice(0, keep) });
        };
      });
      footer();
    };
    /** Marks the selected row (the list itself stays: a double-click's second click lands on the same row). */
    const select = (id: string) => {
      selected = id;
      $$<HTMLElement>(".dp-row[data-id]", list).forEach((r) => { const on = r.dataset.id === id; r.classList.toggle("sel", on); r.setAttribute("aria-selected", String(on)); });
      footer();
    };
    const footer = () => {
      const t = target();
      d.querySelector<HTMLButtonElement>("[data-choose]")!.disabled = !t;
      d.querySelector(".dp-sel")!.innerHTML = t
        ? `${icon(spot.provider === "local" ? "folder" : "drive")}<span class="dp-sel-name" title="${esc(spot.provider === "local" ? t.id : t.name)}">${esc(spot.provider === "local" ? t.id : t.name)}</span>${t.canWrite ? "" : `<span class="dp-tag">view only</span>`}`
        : `<span class="hint">Select a folder, or open one and choose it.</span>`;
    };

    d.querySelector<HTMLButtonElement>("[data-back]")!.onclick = () => { const prev = back.pop(); if (prev) go(prev, false); };
    d.querySelector<HTMLButtonElement>("[data-up]")!.onclick = () => { if (here()) go({ ...spot, trail: spot.trail.slice(0, -1) }); };
    d.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => finish(null);
    d.querySelector<HTMLButtonElement>("[data-choose]")!.onclick = () => { const t = target(); if (t) finish(picked(t)); };
    d.querySelector<HTMLButtonElement>("[data-new]")!.onclick = async () => {
      const h = here();
      if (!h) return;
      const name = await askText({ title: "New folder", text: `In “${h.name}”.`, value: "Trip Planner", ok: "Create", required: true });
      if (!name) return;
      try {
        const f = spot.provider === "local"
          ? await api<Entry>("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ parent: h.id, name }) })
          : await api<Entry>(`/api/sync/${spot.provider === "dropbox" ? "dropbox/" : ""}mkdir`, { method: "POST", body: JSON.stringify({ name, parent: h.id }) });
        await load();
        select(f.id);
        list.querySelector(".dp-row.sel")?.scrollIntoView({ block: "nearest" });
      } catch (e) { toast((e as Error).message); }
    };
    // A pasted link or path: the browser goes there (or, for a Drive link without the sign-in, it's taken as it is).
    d.querySelector<HTMLButtonElement>("[data-paste]")!.onclick = async () => {
      const text = await askText({ title: "Paste a link or path", text: "A Google Drive folder's link (Share → Copy link), or a folder's path on this computer or a network drive (like D:\\Photos\\Japan or \\\\nas\\photos).", placeholder: "https://drive.google.com/drive/folders/…  or  C:\\…", ok: "Go", required: true });
      if (!text) return;
      const c = classifyLink(text);
      if (c.kind === "local") {
        try {
          const f = await api<{ path: string; name: string; canWrite: boolean }>(`/api/fs/check?path=${encodeURIComponent(c.path)}`);
          go({ provider: "local", top: "", trail: crumbsOf(f.path).map((x, i, all) => (i === all.length - 1 ? { ...x, name: f.name, canWrite: f.canWrite } : x)) });
        } catch (e) { toast((e as Error).message); }
      } else if (c.kind === "drive") {
        if (!driveOk) { finish({ provider: "drive", id: c.id, name: "Google Drive folder", canWrite: false, link: driveLink(c.id) }); return; }
        go({ provider: "drive", top: "shared", trail: [{ id: c.id, name: "Pasted folder", canWrite: true }] });
      } else if (c.kind === "dropbox") {
        if (!allowed.includes("dropbox")) await tell({ title: "Dropbox folders can't be used here yet", text: "If the Dropbox app keeps the folder on this computer, choose it under This computer." });
        else finish({ provider: "dropbox", id: c.url, name: "Dropbox folder", canWrite: true, link: c.url });
      } else if (c.kind === "cloud") {
        await tell({ title: `${c.name} links can't be opened here yet`, text: `If the ${c.name} app keeps the folder on this computer, choose it under This computer (${c.name} is listed there when it's set up). Otherwise copy the folder to Google Drive or this computer.` });
      } else toast("That isn't a Google Drive link or a folder's path.");
    };
    // The keyboard: up and down move the selection, Enter opens it, Backspace goes up.
    list.onkeydown = (e) => {
      const folders = (entries || []).filter((x) => x.folder);
      const i = folders.findIndex((x) => x.id === selected);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = folders[Math.max(0, Math.min(folders.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) { select(next.id); list.querySelector(".dp-row.sel")?.scrollIntoView({ block: "nearest" }); }
      } else if (e.key === "Enter" && i >= 0) { e.preventDefault(); into(folders[i]); }
      else if (e.key === "Backspace" && here()) { e.preventDefault(); go({ ...spot, trail: spot.trail.slice(0, -1) }); }
    };

    d.showModal();
    list.focus();
    drawSide(); drawList();
    // The places on this computer and whether Drive can be used, then the first list.
    Promise.all([api<{ entries: Entry[] }>("/api/fs/places").catch(() => ({ entries: [] as Entry[] })), loadSyncStatus()]).then(([p, s]) => {
      places = p.entries; driveOk = !!s?.signedIn; dropboxOk = !!s?.dropbox?.signedIn;
      if (spot.provider === "drive" && !driveOk) spot = { provider: "local", top: "", trail: [] };
      // On this computer, it starts in Pictures (or home) rather than the bare list of places.
      if (spot.provider === "local" && !spot.trail.length) {
        const start = places.find((x) => x.place === "pictures") || places.find((x) => x.place === "home");
        if (start) spot = { provider: "local", top: "", trail: crumbsOf(start.id).map((c, i, all) => (i === all.length - 1 ? { ...c, name: start.name, canWrite: start.canWrite } : c)) };
      }
      drawSide(); load();
    });
  });
}
