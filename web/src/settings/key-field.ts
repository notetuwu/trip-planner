// One way to show and change an API key, wherever a key is asked for (Settings → API keys, the quick-start guide):
// a saved key is a row of dots with its last characters, "Saved", and Change / Remove; Change opens the field to paste
// a new one (Enter saves, Escape goes back). A key from an environment variable is shown the same way, changed there.
import type { KeyStatus } from "../../../shared/types";
import { $$, esc } from "../core/dom";
import { ext, icon } from "../core/icons";

export interface KeyField {
  /** What save() gets back to know which key it is. */
  id: string;
  name: string;
  status?: KeyStatus;
  /** The environment variable it can also come from. */
  env?: string;
  /** Where to get one. */
  url?: string;
  note?: string;
  placeholder?: string;
}

const dots = (s: KeyStatus) => `<span class="kf-dots" title="Saved key, ending in ${esc(s.hint.replace("…", ""))}"><span class="kf-bullets" aria-hidden="true">••••••••••••</span><code>${esc(s.hint.replace("…", ""))}</code></span>`;

export function keyFieldHtml(f: KeyField) {
  const s = f.status, set = !!s?.set, env = s?.source === "env";
  const chip = set ? `<span class="fit ok">${icon("check")} ${env ? "Set" : "Saved"}</span>` : `<span class="fit off">Not set</span>`;
  return `<div class="kf${set ? " is-set" : ""}" data-kf="${esc(f.id)}">
    <div class="kf-head"><b>${esc(f.name)}</b>${chip}${f.url ? `<a class="link-btn kf-get" href="${esc(f.url)}" target="_blank" rel="noopener">Get a key${ext()}</a>` : ""}</div>
    ${f.note ? `<div class="hint">${f.note}</div>` : ""}
    ${set ? `<div class="kf-view">${dots(s!)}
      ${env ? `<span class="hint">From <code>${esc(f.env || "")}</code>: change it there (environment or .env file).</span>`
        : `<button type="button" class="btn" data-kf-edit>${icon("pencil")} Change</button><button type="button" class="icon-btn kf-remove" data-kf-remove title="Remove this key">${icon("trash")}</button>`}
    </div>` : ""}
    ${env ? "" : `<div class="kf-edit"${set ? " hidden" : ""}>
      <input type="password" autocomplete="off" spellcheck="false" placeholder="${esc(f.placeholder || (set ? "Paste the new key" : "Paste the key"))}">
      <button type="button" class="btn solid" data-kf-save>Save</button>
      ${set ? `<button type="button" class="link-btn" data-kf-cancel>Cancel</button>` : ""}
    </div>`}
    <div class="kf-err error-text" hidden></div>
  </div>`;
}

/**
 * Wires the key fields inside `root`. save() stores a key (an empty one removes it) and redraws; a problem it throws is
 * shown under the field.
 */
export function wireKeyFields(root: ParentNode, save: (id: string, key: string) => Promise<unknown>, names: Record<string, string> = {}) {
  for (const el of $$<HTMLElement>("[data-kf]", root)) {
    const id = el.dataset.kf!, input = el.querySelector<HTMLInputElement>(".kf-edit input");
    const edit = el.querySelector<HTMLElement>(".kf-edit"), view = el.querySelector<HTMLElement>(".kf-view"), err = el.querySelector<HTMLElement>(".kf-err")!;
    const run = async (key: string) => {
      err.hidden = true;
      el.classList.add("busy");
      try { await save(id, key); }
      catch (e) { err.textContent = (e as Error).message; err.hidden = false; }
      finally { el.classList.remove("busy"); }
    };
    const open = (on: boolean) => {
      if (!edit || !view) return;
      edit.hidden = !on; view.hidden = on;
      if (on) input?.focus(); else if (input) input.value = "";
    };
    el.querySelector<HTMLButtonElement>("[data-kf-edit]")?.addEventListener("click", () => open(true));
    el.querySelector<HTMLButtonElement>("[data-kf-cancel]")?.addEventListener("click", () => open(false));
    el.querySelector<HTMLButtonElement>("[data-kf-save]")?.addEventListener("click", () => { const k = input?.value.trim(); if (k) run(k); else input?.focus(); });
    el.querySelector<HTMLButtonElement>("[data-kf-remove]")?.addEventListener("click", () => { if (confirm(`Remove the ${names[id] || id} key?`)) run(""); });
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); el.querySelector<HTMLButtonElement>("[data-kf-save]")?.click(); }
      // Escape goes back to the saved key, not out of the dialog.
      if (e.key === "Escape" && view) { e.preventDefault(); e.stopPropagation(); open(false); }
    });
  }
}
