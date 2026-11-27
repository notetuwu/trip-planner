// Who has access to a Drive folder, opened from the folder browser: the people on it, and, where this account may
// share it, adding people, changing what they may do, removing them, "anyone with the link" and limited
// access. Every change goes to Google at once; the ones that take access away or open the folder up ask first.
import type { AccessEntry, FolderAccess } from "../../../shared/types";
import { $$, api, closeOnBackdrop, esc } from "./dom";
import { askConfirm } from "./ask";
import { icon } from "./icons";

const ROLE: Record<AccessEntry["role"], string> = { owner: "Owner", organizer: "Manager", fileOrganizer: "Content manager", writer: "Editor", commenter: "Commenter", reader: "Viewer" };
const RANK = ["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"];

/** Opens the window for one folder; resolves when it's closed, with whether anything was changed. */
export function manageAccess(id: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "keys-dialog fa-dialog";
    d.innerHTML = `<div class="dp-head"><div><h2>Who has access</h2><p class="hint" data-name>${esc(name)}</p></div>
        <form method="dialog"><button class="icon-btn" title="Close">${icon("x")}</button></form></div>
      <div class="fa-body">
        <p class="error-text" data-error role="alert" hidden></p>
        <p class="hint" data-note>Loading…</p>
        <form class="fa-add" hidden>
          <input type="email" required placeholder="Add a person or group by email" autocomplete="off" spellcheck="false" aria-label="Email address">
          <select aria-label="What they may do"></select>
          <button type="submit" class="btn solid">Share</button>
          <label class="fa-notify"><input type="checkbox" checked> Email them a link (needed for an address without a Google account)</label>
        </form>
        <div data-limit></div>
        <div data-people></div>
        <div data-general></div>
      </div>`;
    document.body.append(d);
    closeOnBackdrop(d);
    let access: FolderAccess | null = null, busy = false, changed = false;
    d.addEventListener("close", () => { d.remove(); resolve(changed); });

    const $one = <T extends Element = HTMLElement>(s: string) => d.querySelector<T>(s)!;
    const form = $one<HTMLFormElement>(".fa-add"), email = $one<HTMLInputElement>(".fa-add input[type=email]"), newRole = $one<HTMLSelectElement>(".fa-add select");
    const fail = (message: string) => { const p = $one("[data-error]"); p.textContent = message; p.hidden = !message; if (message) p.scrollIntoView({ block: "nearest" }); };
    const options = (roles: AccessEntry["role"][], on: string) => roles.map((r) => `<option value="${r}"${r === on ? " selected" : ""}>${ROLE[r]}</option>`).join("");
    const label = (p: AccessEntry) => (p.type === "domain" ? `Everyone at ${p.domain || p.name}` : p.name);

    const row = (p: AccessEntry, a: FolderAccess) => {
      const editable = a.canManage && p.role !== "owner" && !p.inherited;
      // Shut out by limited access: a person or group can be let in by adding them to this folder itself.
      const letIn = a.canManage && p.shutOut && !!p.email;
      // A role the list doesn't offer (set elsewhere) still shows as it is.
      const roles = (a.roles as AccessEntry["role"][]).includes(p.role) ? a.roles : [...a.roles, p.role];
      const sub = [p.type === "group" ? "Group" : "", p.email && p.email !== p.name ? p.email : "", p.shutOut ? "Sees the folder's name only" : p.inherited ? "From a folder above" : "", p.until ? `Until ${new Date(p.until).toLocaleDateString()}` : ""].filter(Boolean).join(" · ");
      return `<div class="fa-row">
        <span class="fa-face">${p.type === "user" ? esc((p.name[0] || "?").toUpperCase()) : icon(p.type === "anyone" ? "globe" : "users")}</span>
        <span class="fa-who"><b title="${esc(label(p))}">${esc(label(p))}${p.me ? " (you)" : ""}</b>${sub ? `<small title="${esc(sub)}">${esc(sub)}</small>` : ""}</span>
        ${editable ? `<select data-role="${esc(p.id)}" aria-label="Access of ${esc(label(p))}">${options(roles, p.role)}</select>
          <button type="button" class="icon-btn" data-remove="${esc(p.id)}" title="Remove access">${icon("x")}</button>`
          : letIn ? `<button type="button" class="btn" data-let="${esc(p.id)}" title="Add them to this folder, with the access chosen above">Let in</button>`
          : `<span class="fa-role">${p.shutOut ? "No access" : ROLE[p.role] || esc(p.role)}</span>`}
      </div>`;
    };

    const draw = () => {
      const a = access;
      if (!a) return;
      $one("[data-name]").textContent = a.name || name;
      $one("[data-note]").textContent = a.people === null ? "Google doesn't show this account who else has access. Ask the folder's owner, or someone who may share it."
        : !a.canManage ? "You can see who has access, but this account isn't allowed to change it."
          : a.driveRoot ? "These are the shared drive's members: they get everything in it."
            : "Changes apply to the folder and everything in it.";
      form.hidden = !a.canManage;
      if (!newRole.options.length) newRole.innerHTML = options(a.roles, "writer");
      const people = (a.people || []).filter((p) => p.type !== "anyone"), link = a.people?.find((p) => p.type === "anyone" && !p.shutOut);
      const group = (title: string, list: AccessEntry[]) => (list.length ? `<h3 class="fa-head">${title}</h3>${list.map((p) => row(p, a)).join("")}` : "");
      $one("[data-people]").innerHTML = group(a.driveRoot ? "Members" : "People with access", people.filter((p) => !p.shutOut))
        + group("Can't open this folder", people.filter((p) => p.shutOut));
      $one("[data-limit]").innerHTML = !a.limited && !a.canLimit ? "" : `<h3 class="fa-head">Access from folders above</h3>
        <div class="fa-row">
          <span class="fa-face">${icon(a.limited ? "lock" : "folder")}</span>
          <span class="fa-who"><b>${a.limited ? "Limited access" : "Included"}</b><small>${a.limited ? `Only ${a.sharedDrive ? "managers" : "the owner"} and people added here can open it` : "Access to a folder above also opens this one"}</small></span>
          ${a.canLimit ? `<button type="button" class="btn" data-limited>${a.limited ? "Remove limit" : "Limit access"}</button>` : ""}
        </div>`;
      // "Anyone with the link" isn't for a shared drive itself, only for what's in it.
      const canLink = a.canManage && !a.driveRoot && !link?.inherited;
      $one("[data-general]").innerHTML = a.people === null || (a.driveRoot && !link) ? "" : `<h3 class="fa-head">Anyone with the link</h3>
        <div class="fa-row">
          <span class="fa-face">${icon(link ? "globe" : "lock")}</span>
          <span class="fa-who"><b>${link ? "Anyone with the link" : "Restricted"}</b><small>${link ? `No sign-in needed${link.inherited ? " · From a folder above" : ""}` : "Only the people listed can open it"}</small></span>
          ${canLink ? `<select data-link aria-label="Anyone with the link"><option value="">No access</option>${options(["reader", "commenter", "writer"], link?.role || "")}</select>`
            : `<span class="fa-role">${link ? ROLE[link.role] : "No access"}</span>`}
        </div>`;

      $$<HTMLSelectElement>("[data-role]", d).forEach((s) => {
        s.onchange = async () => {
          const p = a.people!.find((x) => x.id === s.dataset.role)!, role = s.value;
          if (p.me && RANK.indexOf(role) < RANK.indexOf(p.role)
            && !(await askConfirm({ title: "Lower your own access?", text: `You'll be ${ROLE[role as AccessEntry["role"]]} of “${a.name}”, and may not be able to change it back.`, ok: "Change", danger: true }))) return draw();
          change("role", { permission: p.id, role });
        };
      });
      $$<HTMLButtonElement>("[data-remove]", d).forEach((b) => {
        b.onclick = async () => {
          const p = a.people!.find((x) => x.id === b.dataset.remove)!;
          if (await askConfirm(p.me ? { title: "Remove your own access?", text: `You may no longer be able to open “${a.name}” or what's in it.`, ok: "Remove", danger: true }
            : { title: "Remove access?", text: `${label(p)} will no longer get into “${a.name}” through this sharing.`, ok: "Remove", danger: true })) change("remove", { permission: p.id });
        };
      });
      $$<HTMLButtonElement>("[data-let]", d).forEach((b) => {
        b.onclick = () => {
          const p = a.people!.find((x) => x.id === b.dataset.let)!;
          change("add", { email: p.email, role: newRole.value, notify: $one<HTMLInputElement>(".fa-notify input").checked });
        };
      });
      d.querySelector<HTMLButtonElement>("[data-limited]")?.addEventListener("click", async () => {
        const mine = a.people?.find((p) => p.me);
        // Someone who only gets in from above shuts themselves out too (the owner and managers never do).
        const losing = !!mine && mine.inherited && mine.role !== "owner" && mine.role !== "organizer";
        const keepers = a.sharedDrive ? "the shared drive's managers" : "the owner";
        if (await askConfirm(a.limited ? { title: "Remove the limit?", text: `Everyone with access to the folders above can open “${a.name}” and what's in it again.`, ok: "Remove limit" }
          : { title: "Limit access?", text: `Only ${keepers} and people added to “${a.name}” itself will be able to open it. Others with access above still see its name.${losing ? "\n\nYou only get in through a folder above, so you'll lose access yourself. Add yourself here first to keep it." : ""}`, ok: "Limit access", danger: losing })) change("limit", { limited: !a.limited });
      });
      const select = d.querySelector<HTMLSelectElement>("[data-link]");
      if (select) select.onchange = async () => {
        const role = select.value;
        // Opening it up (or letting the link do more) asks first.
        if (role && (!link || RANK.indexOf(role) > RANK.indexOf(link.role))
          && !(await askConfirm({ title: "Open to anyone with the link?", text: `Anyone who has the link to “${a.name}” can ${role === "writer" ? "change, add and delete what's in it" : role === "commenter" ? "see and comment on what's in it" : "see what's in it"}, without signing in.`, ok: "Allow", danger: role === "writer" }))) return draw();
        change("link", { role });
      };
    };

    const lock = (on: boolean) => { busy = on; $$<HTMLInputElement>(".fa-body input, .fa-body select, .fa-body button", d).forEach((x) => { x.disabled = on; }); };
    /** Sends one change and shows the list as it is afterwards; true when Google took it. */
    const change = async (what: "add" | "role" | "remove" | "link" | "limit", body: Record<string, unknown>) => {
      if (busy) return false;
      fail(""); lock(true);
      try {
        const r = await api<{ access: FolderAccess | null }>(`/api/sync/access/${what}`, { method: "POST", body: JSON.stringify({ id, ...body }) });
        changed = true;
        lock(false);
        if (r.access) { access = r.access; draw(); } else d.close(); // (your own access is gone)
        return true;
      } catch (e) {
        lock(false);
        draw(); // (a list choice goes back to how it is)
        fail((e as Error).message);
        return false;
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const ok = await change("add", { email: email.value.trim(), role: newRole.value, notify: $one<HTMLInputElement>(".fa-notify input").checked });
      if (ok) { email.value = ""; email.focus(); }
    };

    d.showModal();
    api<FolderAccess>(`/api/sync/access?id=${encodeURIComponent(id)}`)
      .then((a) => { access = a; draw(); })
      .catch((e) => { $one("[data-note]").textContent = ""; fail((e as Error).message); });
  });
}
