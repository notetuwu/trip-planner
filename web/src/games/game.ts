// What every small game in the games window (games/games.ts) provides. The window runs the loop, the start, pause and
// game-over screens, the score and the best scores; a game only moves, draws and answers keys.

/** The game screen, in CSS pixels (the canvas is sharper on high-density screens). */
export const W = 300, H = 360;

/** The app's colours for the current theme, read from its CSS variables. */
export interface Colors { bg: string; grid: string; ink: string; muted: string; ok: string; accent: string; warn: string; tracks: string[] }

export interface Game {
  readonly id: string;
  readonly title: string;
  /** The keys, under the screen. */
  readonly hint: string;
  score: number;
  over: boolean;
  /** A new game from the start. */
  reset(): void;
  /** Time passing while it's played, in milliseconds (never much more than a frame). */
  update(ms: number): void;
  draw(g: CanvasRenderingContext2D, c: Colors): void;
  /** A key pressed while it's played (KeyboardEvent.code); true when the game used it. */
  key(code: string): boolean;
  keyUp?(code: string): void;
  /** The pointer over the screen, at x (0 to W). */
  pointer?(x: number): void;
}

export function box(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  g.fillStyle = fill; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill();
}

export function gridLines(g: CanvasRenderingContext2D, c: Colors, cell: number, cols: number, rows: number, x0 = 0) {
  g.strokeStyle = c.grid; g.lineWidth = 1; g.beginPath();
  for (let x = 1; x < cols; x++) { g.moveTo(x0 + x * cell + .5, 0); g.lineTo(x0 + x * cell + .5, rows * cell); }
  for (let y = 1; y < rows; y++) { g.moveTo(x0, y * cell + .5); g.lineTo(x0 + cols * cell, y * cell + .5); }
  g.stroke();
}

export const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
