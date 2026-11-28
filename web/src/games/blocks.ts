// Blocks: falling pieces of four squares; fill a row and it clears. Faster every ten rows.
import { box, gridLines, type Colors, type Game } from "./game";

const COLS = 10, ROWS = 20, CELL = 18, SIDE = COLS * CELL + 14;
type Shape = number[][];
const SHAPES: Shape[] = [
  [[1, 1, 1, 1]],
  [[1, 1], [1, 1]],
  [[0, 1, 0], [1, 1, 1]],
  [[1, 0, 0], [1, 1, 1]],
  [[0, 0, 1], [1, 1, 1]],
  [[0, 1, 1], [1, 1, 0]],
  [[1, 1, 0], [0, 1, 1]],
];
const LINE_POINTS = [0, 100, 300, 500, 800];

interface Piece { kind: number; shape: Shape; x: number; y: number }

const turn = (s: Shape): Shape => s[0].map((_, x) => s.map((row) => row[x]).reverse());

export class Blocks implements Game {
  readonly id = "blocks";
  readonly title = "Blocks";
  readonly hint = "←→ move · ↑ turn · ↓ / Enter drop";
  score = 0;
  over = false;
  /** Each cell: 0 empty, else the piece kind + 1 (its colour). */
  private board: number[][] = [];
  private piece!: Piece;
  private next = 0;
  private bag: number[] = [];
  private lines = 0;
  private wait = 0;

  constructor() { this.reset(); }

  private get level() { return Math.floor(this.lines / 10) + 1; }

  reset() {
    this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    this.score = 0; this.lines = 0; this.over = false; this.wait = 0; this.bag = [];
    this.next = this.draw7();
    this.spawn();
  }

  /** Every kind once in each run of seven, in a random order (no long waits for the long piece). */
  private draw7() {
    if (!this.bag.length) { this.bag = [0, 1, 2, 3, 4, 5, 6]; for (let i = 6; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]; } }
    return this.bag.pop()!;
  }

  private spawn() {
    const shape = SHAPES[this.next];
    this.piece = { kind: this.next, shape, x: Math.floor((COLS - shape[0].length) / 2), y: 0 };
    this.next = this.draw7();
    if (this.hits(this.piece.shape, this.piece.x, this.piece.y)) this.over = true;
  }

  private hits(s: Shape, px: number, py: number) {
    return s.some((row, y) => row.some((v, x) => v && (px + x < 0 || px + x >= COLS || py + y >= ROWS || (py + y >= 0 && this.board[py + y][px + x]))));
  }

  private move(dx: number, dy: number) {
    if (this.hits(this.piece.shape, this.piece.x + dx, this.piece.y + dy)) return false;
    this.piece.x += dx; this.piece.y += dy;
    return true;
  }

  private rotate() {
    const s = turn(this.piece.shape);
    // Against a wall or another piece it may shift a little to fit.
    for (const dx of [0, -1, 1, -2, 2]) if (!this.hits(s, this.piece.x + dx, this.piece.y)) { this.piece.shape = s; this.piece.x += dx; return; }
  }

  private lock() {
    const { shape, x, y, kind } = this.piece;
    shape.forEach((row, dy) => row.forEach((v, dx) => { if (v && y + dy >= 0) this.board[y + dy][x + dx] = kind + 1; }));
    const kept = this.board.filter((row) => row.some((v) => !v));
    const cleared = ROWS - kept.length;
    if (cleared) {
      this.score += LINE_POINTS[cleared] * this.level;
      this.lines += cleared;
      this.board = [...Array.from({ length: cleared }, () => Array(COLS).fill(0)), ...kept];
    }
    this.spawn();
  }

  private fall() { if (!this.move(0, 1)) this.lock(); }

  key(code: string) {
    switch (code) {
      case "ArrowLeft": case "KeyA": this.move(-1, 0); return true;
      case "ArrowRight": case "KeyD": this.move(1, 0); return true;
      case "ArrowUp": case "KeyW": case "KeyX": this.rotate(); return true;
      case "ArrowDown": case "KeyS": if (this.move(0, 1)) this.score += 1; else this.lock(); this.wait = 0; return true;
      case "Enter": case "NumpadEnter": { let n = 0; while (this.move(0, 1)) n++; this.score += n * 2; this.lock(); this.wait = 0; return true; }
    }
    return false;
  }

  update(ms: number) {
    this.wait += ms;
    const every = Math.max(80, 800 * Math.pow(.85, this.level - 1));
    while (this.wait >= every && !this.over) { this.wait -= every; this.fall(); }
  }

  private cell(g: CanvasRenderingContext2D, x: number, y: number, color: string, size = CELL) {
    box(g, x + 1, y + 1, size - 2, size - 2, 3, color);
  }

  draw(g: CanvasRenderingContext2D, c: Colors) {
    const colors = [c.ok, c.accent, c.warn, ...c.tracks];
    g.fillStyle = c.bg; g.fillRect(0, 0, 300, ROWS * CELL);
    gridLines(g, c, CELL, COLS, ROWS);
    g.fillStyle = c.grid; g.fillRect(COLS * CELL, 0, 1, ROWS * CELL);
    this.board.forEach((row, y) => row.forEach((v, x) => { if (v) this.cell(g, x * CELL, y * CELL, colors[v - 1]); }));
    // Where the piece would land, faintly.
    const { shape, x, y, kind } = this.piece;
    let ghost = y;
    while (!this.hits(shape, x, ghost + 1)) ghost++;
    g.globalAlpha = .2;
    shape.forEach((row, dy) => row.forEach((v, dx) => { if (v) this.cell(g, (x + dx) * CELL, (ghost + dy) * CELL, colors[kind]); }));
    g.globalAlpha = 1;
    shape.forEach((row, dy) => row.forEach((v, dx) => { if (v && y + dy >= 0) this.cell(g, (x + dx) * CELL, (y + dy) * CELL, colors[kind]); }));
    // Beside the board: what comes next, the rows and the level.
    g.fillStyle = c.muted; g.font = "600 11px Inter, system-ui, sans-serif"; g.textBaseline = "top";
    g.fillText("NEXT", SIDE, 10);
    SHAPES[this.next].forEach((row, dy) => row.forEach((v, dx) => { if (v) this.cell(g, SIDE + dx * 16, 30 + dy * 16, colors[this.next], 16); }));
    g.fillText("ROWS", SIDE, 90); g.fillText("LEVEL", SIDE, 140);
    g.fillStyle = c.ink; g.font = "700 18px Inter, system-ui, sans-serif";
    g.fillText(String(this.lines), SIDE, 106); g.fillText(String(this.level), SIDE, 156);
  }
}
