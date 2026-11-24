// Recover (under Your trips): getting work back. Two lists: the copies kept of the trip that was open whenever another trip
// replaced it, and the earlier versions of each saved trip (the last 40, from before each overwrite).
import type { SaveSummary } from "../../../shared/types";
import { $, api, closeOnBackdrop, esc, toast } from "../core/dom";
import { icon } from "../core/icons";
import { state } from "../core/state";

interface Item { id: string; savedAt: string; size: number; cities: string[]; days: number; items: number; chat: number; name: string }
/** What restoring does (saves.ts): open a copy, or go back to a version. They say whether it was done. */
interface Actions { copy: (id: string) => Promise<boolean>; version: (name: string, id: string) => Promise<boolean> }

let actions: Actions, dlg: HTMLDialogElement | null = null, picked = "";

const when = (iso: string) => {
  const d = new Date(iso), now = new Date();
  const day = d.toDateString() === now.toDateString() ? "Today" : d.toDateString() === new Date(now.getTime() - 864e5).toDateString() ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};
const row = (it: Item, kind: "copy" | "version", extra = "") => `<li>
  <div><b>${esc(when(it.savedAt))}</b><span class="hint">${esc(it.cities.join(" → ") || "No stays")} · ${it.days ? `${it.days} day${it.days === 1 ? "" : "s"}, ${it.items} stops` : "no plan"}${it.chat ? ` · ${it.chat} chat messages` : ""}${extra}</span></div>
  <button type="button" class="btn" data-${kind}="${esc(it.id)}">${kind === "copy" ? "Open" : "Restore"}</button></li>`;

async function render() {
  if (!dlg) return;
  const body = dlg.querySelector<HTMLElement>(".rc-body")!;
  let copies: Item[] = [], versioned: string[] = [], saves: SaveSummary[] = [];
  try {
    const r = await api<{ copies: Item[]; versioned: string[] }>("/api/rescue");
    copies = r.copies; versioned = r.versioned;
    saves = await api<SaveSummary[]>("/api/saves");
  } catch (e) { body.innerHTML = `<p class="hint">Couldn't reach the planner: ${esc((e as Error).message)}</p>`; return; }
  // The trips to pick from: those that have versions, and the saved ones (a deleted trip's versions are still there).
  const names = [...new Set([...versioned, ...saves.map((s) => s.name)])].sort((a, b) => a.localeCompare(b));
  if (!picked || !names.includes(picked)) picked = state.saveName && names.includes(state.saveName) ? state.saveName : (versioned[0] || names[0] || "");
  const versions = picked ? await api<Item[]>(`/api/saves/${encodeURIComponent(picked)}/history`).catch(() => []) : [];
  body.innerHTML = `
    <section>
      <h3>Trips that were replaced</h3>
      <p class="hint">Whenever another trip is opened, imported or started while the open one had changes that weren't saved, a copy is kept (the last ${20}).</p>
      <ul class="rc-list">${copies.length ? copies.map((c) => row(c, "copy", c.name ? ` · was "${esc(c.name)}"` : " · never saved")).join("") : `<li class="empty">Nothing yet. A copy appears here when it's needed.</li>`}</ul>
    </section>
    <section>
      <h3>Earlier versions of a saved trip</h3>
      <p class="hint">Before a save is overwritten, what it held is kept (one version every 10 minutes while you work, and one for each time you press Save; the last 40).</p>
      ${names.length ? `<select class="rc-pick">${names.map((n) => `<option value="${esc(n)}"${n === picked ? " selected" : ""}>${esc(n)}${saves.some((s) => s.name === n) ? "" : " (deleted)"}</option>`).join("")}</select>` : ""}
      <ul class="rc-list">${versions.length ? versions.map((v) => row(v, "version")).join("") : `<li class="empty">${picked ? "No earlier versions of this trip yet." : "No saved trips yet."}</li>`}</ul>
    </section>`;
  body.querySelector<HTMLSelectElement>(".rc-pick")?.addEventListener("change", (e) => { picked = (e.target as HTMLSelectElement).value; render(); });
  body.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => { b.onclick = async () => { if (await actions.copy(b.dataset.copy!).catch((e) => { toast((e as Error).message); return false; })) dlg!.close(); }; });
  body.querySelectorAll<HTMLButtonElement>("[data-version]").forEach((b) => { b.onclick = async () => { if (await actions.version(picked, b.dataset.version!).catch((e) => { toast((e as Error).message); return false; })) dlg!.close(); }; });
}

export function openRecover() {
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "keys-dialog recover-dialog";
    dlg.innerHTML = `<div class="pl-head"><h2>${icon("history")} Recover</h2><span class="hint">Get work back that was replaced or overwritten.</span>
      <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div><div class="rc-body"></div>`;
    document.body.append(dlg);
    closeOnBackdrop(dlg);
  }
  if (!dlg.open) dlg.showModal();
  dlg.querySelector<HTMLElement>(".rc-body")!.innerHTML = `<p class="hint">Loading…</p>`;
  render();
}

export function initRecover(a: Actions) {
  actions = a;
  $("#tripsRecover").onclick = openRecover;
}
