// The app's own small dialogs, in place of the browser's prompt(), confirm() and alert() (which look like a web page
// interrupting, and can't be styled): a question with a text field, a yes/no, a message. They open over whatever is
// open (Settings, Your trips…); Enter confirms, Escape or a click outside cancels.
import { closeOnBackdrop, esc } from "./dom";
import { icon } from "./icons";

interface Base {
  /** The heading ("Rename trip"). */
  title: string;
  /** Text under it, explaining (plain text; line breaks are kept). */
  text?: string;
  /** The confirming button ("Rename", "Delete"); a dangerous one is drawn in red. */
  ok?: string;
  cancel?: string;
  danger?: boolean;
}

function open<T>(o: Base, body: string, read: (d: HTMLDialogElement) => T, cancelled: T, focus: (d: HTMLDialogElement) => void): Promise<T> {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "keys-dialog ask-dialog";
    d.innerHTML = `<form method="dialog" class="ask-form">
        <h3>${o.danger ? icon("warn") : ""}${esc(o.title)}</h3>
        ${o.text ? `<p class="ask-text">${esc(o.text)}</p>` : ""}
        ${body}
        <div class="ask-acts">${o.cancel === "" ? "" : `<button type="button" class="btn" data-no>${esc(o.cancel || "Cancel")}</button>`}<button type="submit" class="btn solid${o.danger ? " danger" : ""}" value="ok">${esc(o.ok || "OK")}</button></div>
      </form>`;
    document.body.append(d);
    closeOnBackdrop(d);
    let answer = cancelled, settled = false;
    const form = d.querySelector<HTMLFormElement>("form")!;
    form.onsubmit = (e) => { e.preventDefault(); answer = read(d); d.close(); };
    d.querySelector<HTMLButtonElement>("[data-no]")?.addEventListener("click", () => d.close());
    d.addEventListener("close", () => { if (settled) return; settled = true; d.remove(); resolve(answer); });
    d.showModal();
    focus(d);
  });
}

/** Asks for some text; resolves with it (trimmed), or null when cancelled. */
export function askText(o: Base & { value?: string; placeholder?: string; label?: string; multiline?: boolean; required?: boolean }): Promise<string | null> {
  const field = o.multiline
    ? `<textarea class="ask-input" rows="3" placeholder="${esc(o.placeholder || "")}">${esc(o.value || "")}</textarea>`
    : `<input class="ask-input" type="text" value="${esc(o.value || "")}" placeholder="${esc(o.placeholder || "")}" autocomplete="off" spellcheck="false"${o.required ? " required" : ""}>`;
  return open<string | null>(o, `${o.label ? `<label class="ask-label">${esc(o.label)}</label>` : ""}${field}`,
    (d) => d.querySelector<HTMLInputElement | HTMLTextAreaElement>(".ask-input")!.value.trim(), null,
    (d) => {
      const f = d.querySelector<HTMLInputElement | HTMLTextAreaElement>(".ask-input")!;
      f.focus(); f.select();
      // In a box of several lines, Enter is a new line; Ctrl/Cmd+Enter sends.
      if (o.multiline) f.addEventListener("keydown", (e) => { const k = e as KeyboardEvent; if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) { e.preventDefault(); d.querySelector<HTMLFormElement>("form")!.requestSubmit(); } });
    });
}

/** Asks yes or no; resolves true for yes. */
export function askConfirm(o: Base): Promise<boolean> {
  return open<boolean>(o, "", () => true, false, (d) => d.querySelector<HTMLButtonElement>('button[type="submit"]')!.focus());
}

/** Tells something, with one button. */
export function tell(o: Omit<Base, "cancel" | "danger">): Promise<void> {
  return open<void>({ ...o, cancel: "" }, "", () => undefined, undefined, (d) => d.querySelector<HTMLButtonElement>('button[type="submit"]')!.focus());
}
