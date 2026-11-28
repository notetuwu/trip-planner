// Snake: eat the dots, don't hit the walls or yourself. A little faster with every dot.
import { box, gridLines, pick, type Colors, type Game } from "./game";

const COLS = 15, ROWS = 18, CELL = 20;
type P = { x: number; y: number };
const DIRS: Record<string, P> = {
  ArrowUp: { x: 0, y: -1 }, KeyW: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, KeyS: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, KeyA: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, KeyD: { x: 1, y: 0 },
};

export class Snake implements Game {
  readonly id = "snake";
  readonly title = "Snake";
  readonly hint = "Arrows / WASD · Space";
  score = 0;
  over = false;
  private body: P[] = [];
  private dir: P = { x: 1, y: 0 };
  /** Turns pressed faster than the snake moves, taken one per step. */
  private turns: P[] = [];
  private food: P = { x: 0, y: 0 };
  private wait = 0;

  constructor() { this.reset(); }

  reset() {
    this.body = [{ x: 6, y: 9 }, { x: 5, y: 9 }, { x: 4, y: 9 }];
    this.dir = { x: 1, y: 0 }; this.turns = []; this.score = 0; this.over = false; this.wait = 0;
    this.placeFood();
  }

  private placeFood() {
    const free: P[] = [];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!this.body.some((b) => b.x === x && b.y === y)) free.push({ x, y });
    if (free.length) this.food = pick(free); else this.over = true;
  }

  key(code: string) {
    const d = DIRS[code];
    if (!d) return false;
    const last = this.turns.at(-1) ?? this.dir;
    // Not straight back into itself, and not the way it's already going.
    if ((d.x !== -last.x || d.y !== -last.y) && (d.x !== last.x || d.y !== last.y) && this.turns.length < 2) this.turns.push(d);
    return true;
  }

  update(ms: number) {
    this.wait += ms;
    const every = Math.max(65, 140 - this.score * 3);
    while (this.wait >= every && !this.over) { this.wait -= every; this.step(); }
  }

  private step() {
    if (this.turns.length) this.dir = this.turns.shift()!;
    const head = this.body[0], next = { x: head.x + this.dir.x, y: head.y + this.dir.y };
    const eats = next.x === this.food.x && next.y === this.food.y;
    // The tail moves out of the way this step unless the snake grows.
    const solid = eats ? this.body : this.body.slice(0, -1);
    if (next.x < 0 || next.y < 0 || next.x >= COLS || next.y >= ROWS || solid.some((b) => b.x === next.x && b.y === next.y)) { this.over = true; return; }
    this.body.unshift(next);
    if (eats) { this.score++; this.placeFood(); } else this.body.pop();
  }

  draw(g: CanvasRenderingContext2D, c: Colors) {
    g.fillStyle = c.bg; g.fillRect(0, 0, COLS * CELL, ROWS * CELL);
    gridLines(g, c, CELL, COLS, ROWS);
    g.fillStyle = c.accent; g.beginPath(); g.arc(this.food.x * CELL + CELL / 2, this.food.y * CELL + CELL / 2, CELL * .36, 0, Math.PI * 2); g.fill();
    this.body.forEach((b, i) => {
      g.globalAlpha = i === 0 ? 1 : Math.max(.55, .9 - i * .015);
      box(g, b.x * CELL + 1.5, b.y * CELL + 1.5, CELL - 3, CELL - 3, 4, c.ok);
    });
    g.globalAlpha = 1;
  }
}
