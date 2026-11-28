// Bricks: keep the ball up with the paddle and knock out every brick. Three balls; each cleared wall comes back faster.
import { box, W, H, type Colors, type Game } from "./game";

const COLS = 8, ROWS = 6, BW = 33, BH = 12, GAP = 3, TOP = 40, LEFT = (W - COLS * (BW + GAP) + GAP) / 2;
const PW = 56, PH = 8, PY = H - 26, R = 5;

export class Bricks implements Game {
  readonly id = "bricks";
  readonly title = "Bricks";
  readonly hint = "←→ / AD or the mouse · Space";
  score = 0;
  over = false;
  private bricks: boolean[][] = [];
  private px = W / 2;
  private ball = { x: 0, y: 0, vx: 0, vy: 0 };
  /** The ball waits on the paddle this long before it goes (a new ball or a new wall). */
  private hold = 0;
  private lives = 3;
  private wall = 1;
  private held = new Set<string>();

  constructor() { this.reset(); }

  reset() {
    this.score = 0; this.lives = 3; this.wall = 1; this.over = false; this.px = W / 2; this.held.clear();
    this.build(); this.serve();
  }

  private build() { this.bricks = Array.from({ length: ROWS }, () => Array(COLS).fill(true)); }

  private serve() {
    const speed = .2 + this.wall * .03;
    this.ball = { x: this.px, y: PY - R - 1, vx: speed * (Math.random() < .5 ? -.6 : .6), vy: -speed * .8 };
    this.hold = 700;
  }

  key(code: string) {
    if (!["ArrowLeft", "KeyA", "ArrowRight", "KeyD"].includes(code)) return false;
    this.held.add(code);
    return true;
  }
  keyUp(code: string) { this.held.delete(code); }
  pointer(x: number) { this.px = Math.min(W - PW / 2, Math.max(PW / 2, x)); }

  update(ms: number) {
    const dir = (this.held.has("ArrowRight") || this.held.has("KeyD") ? 1 : 0) - (this.held.has("ArrowLeft") || this.held.has("KeyA") ? 1 : 0);
    if (dir) this.pointer(this.px + dir * .38 * ms);
    if (this.hold > 0) { this.hold -= ms; this.ball.x = this.px; return; }
    // Small steps, so a fast ball can't pass through a brick between two frames.
    for (let left = ms; left > 0 && !this.over; left -= 4) this.step(Math.min(4, left));
  }

  private step(ms: number) {
    const b = this.ball;
    b.x += b.vx * ms; b.y += b.vy * ms;
    if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx); }
    if (b.x > W - R) { b.x = W - R; b.vx = -Math.abs(b.vx); }
    if (b.y < R) { b.y = R; b.vy = Math.abs(b.vy); }
    // The paddle: where it's hit sets the angle.
    if (b.vy > 0 && b.y + R >= PY && b.y + R <= PY + PH + 4 && Math.abs(b.x - this.px) <= PW / 2 + R) {
      const speed = Math.hypot(b.vx, b.vy), off = (b.x - this.px) / (PW / 2 + R);
      b.vx = speed * Math.sin(off * 1.05); b.vy = -speed * Math.cos(off * 1.05); b.y = PY - R;
    }
    if (b.y > H + R) {
      if (--this.lives <= 0) { this.over = true; return; }
      this.serve(); return;
    }
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (!this.bricks[y][x]) continue;
      const bx = LEFT + x * (BW + GAP), by = TOP + y * (BH + GAP);
      const nx = Math.max(bx, Math.min(b.x, bx + BW)), ny = Math.max(by, Math.min(b.y, by + BH));
      if ((b.x - nx) ** 2 + (b.y - ny) ** 2 > R * R) continue;
      this.bricks[y][x] = false;
      this.score += (ROWS - y) * 5;
      // Off the side it hit: a top or bottom face flips it up or down, a side face left or right.
      const overlapX = Math.min(b.x + R - bx, bx + BW - (b.x - R)), overlapY = Math.min(b.y + R - by, by + BH - (b.y - R));
      if (overlapX < overlapY) b.vx = -b.vx; else b.vy = -b.vy;
      if (this.bricks.every((row) => row.every((v) => !v))) { this.wall++; this.build(); this.serve(); }
      return;
    }
  }

  draw(g: CanvasRenderingContext2D, c: Colors) {
    const colors = [c.accent, c.warn, c.ok, ...c.tracks];
    g.fillStyle = c.bg; g.fillRect(0, 0, W, H);
    this.bricks.forEach((row, y) => row.forEach((v, x) => { if (v) box(g, LEFT + x * (BW + GAP), TOP + y * (BH + GAP), BW, BH, 3, colors[y % colors.length]); }));
    box(g, this.px - PW / 2, PY, PW, PH, 4, c.ink);
    g.fillStyle = c.ink; g.beginPath(); g.arc(this.ball.x, this.ball.y, R, 0, Math.PI * 2); g.fill();
    // The balls left, top left.
    for (let i = 0; i < this.lives; i++) { g.fillStyle = c.muted; g.beginPath(); g.arc(12 + i * 13, 16, 4, 0, Math.PI * 2); g.fill(); }
    if (this.wall > 1) { g.fillStyle = c.muted; g.font = "600 11px Inter, system-ui, sans-serif"; g.textAlign = "right"; g.textBaseline = "middle"; g.fillText(`WALL ${this.wall}`, W - 10, 16); g.textAlign = "left"; }
  }
}
