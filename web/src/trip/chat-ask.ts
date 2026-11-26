// The chat's question with answers to pick from: it sits in the message box, which grows upwards to hold it. The
// conversation goes on once it's answered: with an answer picked (a single one is sent at once, several with Send), or
// in their own words, where writing in the box (or adding a picture) picks "Other".
import { esc } from "../core/dom";
import { icon } from "../core/icons";
import { withoutClosingQuestion } from "./chat-ask-text";

export { withoutClosingQuestion };

export interface Ask { q: string; options: string[]; multi?: boolean; answered?: string }

/** What's picked of the open question: the answers ticked, and whether they're writing their own. `write`: the box got
 *  something to send of their own, or was emptied again. */
export const picks = { ask: null as Ask | null, chosen: new Set<string>(), other: false, write: (_has: boolean) => {} };

/** How the box grows to hold a question and shrinks again: quick to start, settling gently. */
const EASE = "cubic-bezier(.2, .8, .2, 1)", OPEN = 320, CLOSE = 180;
/** Nothing to animate while the chat isn't on screen, or when they've asked for less motion. */
const still = (dock: HTMLElement) => !dock.offsetHeight || matchMedia("(prefers-reduced-motion: reduce)").matches;
/** From shut to as tall as it is (or back): the box's top edge moves, since its foot stays where it is. */
function resize(dock: HTMLElement, opening: boolean) {
  const shut = { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginBottom: "0px", opacity: 0 };
  const style = getComputedStyle(dock);
  const full = { height: `${dock.offsetHeight}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginBottom: style.marginBottom, opacity: 1 };
  dock.classList.add("moving");
  return dock.animate(opening ? [shut, full] : [full, shut], { duration: opening ? OPEN : CLOSE, easing: EASE, fill: opening ? "none" : "forwards" });
}

/** The box grows upwards and the answers come up into it one after another. */
function open(dock: HTMLElement) {
  if (still(dock)) return;
  resize(dock, true).onfinish = () => dock.classList.remove("moving");
  [...dock.querySelectorAll<HTMLElement>(".cp-ask-head, .cp-opt")].forEach((el, i) =>
    el.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 50 + i * 45, easing: EASE, fill: "backwards" }));
}

/** The question goes: the box shrinks back down. */
function shut(dock: HTMLElement) {
  if (dock.classList.contains("closing")) return;
  const gone = () => { dock.hidden = true; dock.innerHTML = ""; dock.classList.remove("moving", "closing"); for (const a of dock.getAnimations()) a.cancel(); };
  if (dock.hidden || !dock.childElementCount || still(dock)) return gone();
  dock.classList.add("closing");
  resize(dock, false).onfinish = gone;
}

/** The question's rows. `onChange`: something was picked or unpicked; `onSend`: send what's picked. */
export function drawAsk(dock: HTMLElement, a: Ask | null, o: { onChange: () => void; onSend: () => void; box: HTMLTextAreaElement }) {
  if (!a) { picks.ask = null; shut(dock); return; }
  // (A new question while the last one was still going away.)
  for (const x of dock.getAnimations()) if (dock.classList.contains("closing")) x.cancel();
  dock.classList.remove("closing");
  dock.hidden = false;
  const fresh = picks.ask !== a;
  if (fresh) { picks.ask = a; picks.chosen.clear(); picks.other = false; }
  // (Drawn again for the same question, with the same rows: left as it is, so the focus stays.)
  else if (dock.childElementCount) return;
  const n = a.options.length + 1;
  const row = (i: number, text: string, other = false) =>
    `<button type="button" class="cp-opt${other ? " other" : ""}" role="${a.multi ? "checkbox" : "radio"}" data-opt="${i}"><span class="cp-opt-n">${i + 1}</span><span class="cp-opt-text">${text}</span>${icon("check")}</button>`;
  dock.innerHTML = `<div class="cp-ask-head"><b class="cp-ask-q">${esc(a.q)}</b><span class="hint">${a.multi ? "Pick any" : "Pick one"}</span></div>
    <div class="cp-ask-list" role="group" aria-label="${esc(a.q)}">${a.options.map((x, i) => row(i, esc(x))).join("")}${row(n - 1, `Other <span class="hint">write your own answer</span>`, true)}</div>`;
  const rows = [...dock.querySelectorAll<HTMLButtonElement>("[data-opt]")];
  const mark = () => rows.forEach((b, i) => {
    const on = i === n - 1 ? picks.other : picks.chosen.has(a.options[i]);
    b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on));
  });
  const pick = (i: number) => {
    if (i === n - 1) {
      picks.other = !picks.other;
      if (!a.multi) picks.chosen.clear();
    } else {
      const value = a.options[i];
      if (!a.multi) { picks.chosen.clear(); picks.chosen.add(value); picks.other = false; }
      else if (picks.chosen.has(value)) picks.chosen.delete(value); else picks.chosen.add(value);
    }
    mark(); o.onChange();
    if (i === n - 1 && picks.other) o.box.focus();
    else if (!a.multi && i < n - 1) o.onSend();
  };
  rows.forEach((b, i) => { b.onclick = () => pick(i); });
  picks.write = (has) => {
    if (picks.ask !== a || picks.other === has) return;
    picks.other = has;
    if (has && !a.multi) picks.chosen.clear();
    mark(); o.onChange();
  };
  dock.onkeydown = (e) => {
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const num = /^[1-9]$/.test(e.key) ? +e.key - 1 : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      rows[(Math.max(0, at) + (e.key === "ArrowDown" ? 1 : n - 1)) % n].focus();
    } else if (num >= 0 && num < n) { e.preventDefault(); rows[num].focus(); pick(num); }
    // Enter on a row picks it (the button does that itself); with several ticked, it sends them.
    else if (e.key === "Enter" && a.multi && picks.chosen.size) { e.preventDefault(); o.onSend(); }
  };
  mark();
  // Something already written (while the reply was coming) counts as their own answer.
  if (o.box.value.trim()) picks.write(true);
  if (fresh) open(dock);
  // Ready for the keyboard, unless they're busy somewhere else.
  if (fresh && window.innerWidth > 900 && document.activeElement === document.body) rows[0].focus({ preventScroll: true });
}
