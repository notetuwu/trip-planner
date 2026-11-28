// A small window of games to pass the time while a plan is being made: Snake, Blocks and Bricks. It opens from the
// header (a computer only, never on a phone), floats over the page and can be dragged by its top or folded down to it.
// The best score of each game is kept in this browser (localStorage), never in the trip.
import { $ } from "../core/dom";
import { icon } from "../core/icons";
import { isPhone } from "../core/layout";
import { Blocks } from "./blocks";
import { Bricks } from "./bricks";
import { W, H, type Colors, type Game } from "./game";
import { Snake } from "./snake";

const BEST = "trip-planner-game-best", LAST = "trip-planner-game", SPOT = "trip-planner-game-spot";
type Status = "ready" | "playing" | "paused" | "over";

const games: Game[] = [new Snake(), new Blocks(), new Bricks()];
let game = games.find((g) => g.id === localStorage.getItem(LAST)) ?? games[0];
let status: Status = "ready";
let folded = false;
let frame = 0, lastTime = 0;
let win: HTMLElement, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D;

const bests = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(BEST) || "{}"); } catch { return {}; } };
const best = (id: string) => bests()[id] || 0;

function colors(): Colors {
  const css = getComputedStyle(document.documentElement), v = (n: string) => css.getPropertyValue(n).trim();
  return { bg: v("--field"), grid: v("--line"), ink: v("--ink"), muted: v("--muted"), ok: v("--ok"), accent: v("--accent"), warn: v("--warn"),
    tracks: ["--track-0", "--track-1", "--track-2", "--track-3"].map(v) };
}

const open = () => !win.hidden && !folded;

function paint() {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  game.draw(ctx, colors());
}

function loop(now: number) {
  frame = 0;
  if (!open()) return;
  if (status === "playing") {
    game.update(Math.min(50, now - lastTime));
    if (game.over) finish();
  }
  lastTime = now;
  paint(); score();
  frame = requestAnimationFrame(loop);
}
const run = () => { if (!frame && open()) { lastTime = performance.now(); frame = requestAnimationFrame(loop); } };

function score() {
  $("#gmScore").innerHTML = `Score ${game.score}<small>Best ${Math.max(best(game.id), game.score)}</small>`;
}

/** The screen over the game: start, paused or game over, each with one big button across it. */
function screen() {
  const over = $("#gmOver"), pause = $<HTMLButtonElement>("#gmPause");
  pause.disabled = status === "ready" || status === "over";
  pause.innerHTML = status === "paused" ? `${icon("play")} Resume` : `${icon("pause")} Pause`;
  over.hidden = status === "playing";
  if (status === "playing") return;
  const b = best(game.id);
  const text = status === "ready" ? `<b>${game.title}</b><span>${b ? `Best ${b}` : "No best score yet"}</span>`
    : status === "paused" ? `<b>Paused</b><span>Score ${game.score}</span>`
    : `<b>Game over</b><span>Score ${game.score}${game.score > 0 && game.score >= b ? " · a new best!" : ` · best ${b}`}</span>`;
  const btn = status === "ready" ? `${icon("play")} Start` : status === "paused" ? `${icon("play")} Resume` : `${icon("refresh")} Play again`;
  over.innerHTML = `<div class="gm-msg">${text}</div><button class="btn solid gm-big" id="gmGo" type="button">${btn}</button>`;
}

function setStatus(s: Status) { status = s; screen(); score(); run(); }

function start() {
  if (status === "paused") return setStatus("playing");
  if (status === "over") game.reset();
  setStatus("playing");
}
const pause = () => {
  // A key held when the game stops is never seen released (the window lost the keyboard): let go of it.
  for (const code of ["ArrowLeft", "ArrowRight", "KeyA", "KeyD"]) game.keyUp?.(code);
  if (status === "playing") setStatus("paused");
};

function finish() {
  const all = bests();
  if (game.score > (all[game.id] || 0)) { all[game.id] = game.score; localStorage.setItem(BEST, JSON.stringify(all)); }
  setStatus("over");
}

function choose(id: string) {
  const next = games.find((g) => g.id === id);
  if (!next || next === game) return;
  game = next; localStorage.setItem(LAST, id);
  game.reset();
  for (const t of win.querySelectorAll<HTMLElement>(".gm-tab")) t.setAttribute("aria-selected", String(t.dataset.game === id));
  $("#gmHint").textContent = game.hint;
  setStatus("ready"); paint();
}

function fold(on: boolean) {
  folded = on; win.classList.toggle("folded", on);
  $("#gmFold").innerHTML = icon(on ? "maximize" : "minus");
  $("#gmFold").title = on ? "Show the game again" : "Fold down to this bar (the game pauses)";
  if (on) pause(); else { paint(); run(); }
}

export function toggleGames(show = win.hidden) {
  if (show && isPhone()) return;
  win.hidden = !show;
  $("#gamesBtn").setAttribute("aria-pressed", String(show));
  if (show) { place(); paint(); score(); run(); }
  else {
    pause();
    // "Your plan is ready" has been seen: not there again the next time the games are opened.
    const line = $("#gmPlan");
    if (line.classList.contains("ready")) line.hidden = true;
  }
}

/** Keeps the window inside the page (it was dragged, or the window got smaller). */
function place() {
  const r = win.getBoundingClientRect();
  if (!win.style.left) return;
  win.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, parseFloat(win.style.left)))}px`;
  win.style.top = `${Math.max(8, Math.min(innerHeight - 40, parseFloat(win.style.top)))}px`;
}

function drag(head: HTMLElement) {
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
    const r = win.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId); win.classList.add("dragging");
    const move = (m: PointerEvent) => {
      win.style.left = `${m.clientX - dx}px`; win.style.top = `${m.clientY - dy}px`;
      win.style.right = win.style.bottom = "auto"; place();
    };
    const up = () => {
      head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); head.removeEventListener("pointercancel", up); win.classList.remove("dragging");
      localStorage.setItem(SPOT, JSON.stringify({ left: win.style.left, top: win.style.top }));
    };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up); head.addEventListener("pointercancel", up);
  });
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function keys() {
  addEventListener("keydown", (e) => {
    if (!open() || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    // Space pauses and resumes while playing; otherwise only when nothing else on the page has the keyboard.
    const mine = e.target === document.body || win.contains(e.target as Node);
    if (e.code === "Space" && (status === "playing" || mine)) {
      e.preventDefault(); e.stopPropagation();
      if (status === "playing") pause(); else start();
      return;
    }
    if (status === "playing" && game.key(e.code)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  addEventListener("keyup", (e) => game.keyUp?.(e.code), true);
}

export function initGames() {
  win = document.createElement("section");
  win.className = "games"; win.hidden = true; win.setAttribute("aria-label", "Games");
  win.innerHTML = `
    <div class="gm-head" id="gmHead">
      <div class="gm-tabs" role="tablist">${games.map((g) => `<button class="gm-tab" type="button" role="tab" data-game="${g.id}" aria-selected="${g === game}">${g.title}</button>`).join("")}</div>
      <span class="gm-score" id="gmScore"></span>
      <button class="icon-btn" id="gmFold" type="button"></button>
      <button class="icon-btn" id="gmClose" type="button" title="Close (the game pauses)" aria-label="Close">${icon("x")}</button>
    </div>
    <div class="gm-screen"><canvas width="${W}" height="${H}"></canvas><div class="gm-over" id="gmOver"></div></div>
    <div class="gm-plan" id="gmPlan" hidden></div>
    <div class="gm-foot"><button class="btn solid" id="gmPause" type="button"></button><span class="gm-hint" id="gmHint">${game.hint}</span></div>`;
  document.body.append(win);
  canvas = win.querySelector("canvas")!; ctx = canvas.getContext("2d")!;
  try { const s = JSON.parse(localStorage.getItem(SPOT) || "null"); if (s?.left) Object.assign(win.style, { left: s.left, top: s.top, right: "auto", bottom: "auto" }); } catch { /* the corner */ }

  $("#gamesBtn").addEventListener("click", () => toggleGames());
  $("#gmClose").addEventListener("click", () => toggleGames(false));
  $("#gmFold").addEventListener("click", () => fold(!folded));
  $("#gmPause").addEventListener("click", (e) => { (e.currentTarget as HTMLElement).blur(); if (status === "playing") pause(); else start(); });
  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#gmGo")) { t.closest<HTMLElement>("#gmGo")!.blur(); start(); }
    const tab = t.closest<HTMLElement>(".gm-tab");
    if (tab) { tab.blur(); choose(tab.dataset.game!); }
  });
  canvas.addEventListener("pointermove", (e) => { if (status === "playing") game.pointer?.((e.clientX - canvas.getBoundingClientRect().left) * W / canvas.clientWidth); });
  drag($("#gmHead"));
  keys();

  // Doing something else on the page, or leaving it, pauses the game; the keys go back to the page.
  document.addEventListener("pointerdown", (e) => { if (!win.contains(e.target as Node)) pause(); }, true);
  addEventListener("blur", pause);
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  addEventListener("resize", () => { if (isPhone() && !win.hidden) toggleGames(false); else place(); });

  // While a plan is being made, and once it's ready, a line under the game says so.
  addEventListener("generation-state", (e) => {
    const { busy, ok } = (e as CustomEvent<{ busy: boolean; ok?: boolean }>).detail, line = $("#gmPlan");
    line.hidden = !busy && !ok;
    line.className = `gm-plan${busy ? "" : " ready"}`;
    line.innerHTML = busy ? `${icon("hourglass")} Your plan is being made…` : `${icon("check")} Your plan is ready`;
  });

  fold(false); screen(); score(); paint();
}
