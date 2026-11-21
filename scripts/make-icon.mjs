// Draws the app icon (the logo's red dot on a dark rounded square, with a dotted route) and writes
// packaging/icon.png, packaging/icon.ico and public/favicon.png. Run once after changing the design: node scripts/make-icon.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const ACCENT = [255, 77, 106], BG = [30, 27, 24], INK = [237, 232, 225];

/** RGBA pixels of the icon at a size, with 4x4 supersampling for smooth edges. */
function draw(size) {
  const px = Buffer.alloc(size * size * 4), S = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size; // 0..1
      const c = shade(u, v);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
    }
    const n = S * S, i = (y * size + x) * 4, cov = a / 255;
    if (cov) { px[i] = r / cov; px[i + 1] = g / cov; px[i + 2] = b / cov; }
    px[i + 3] = a / n;
  }
  return px;
}

/** Colour at a point of the unit square, or null for transparent. */
function shade(u, v) {
  const R = 0.2, inset = 0.04; // rounded square
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - inset - R), 0), dy = Math.max(Math.abs(v - 0.5) - (0.5 - inset - R), 0);
  if (Math.hypot(dx, dy) > R) return null;
  if (Math.hypot(u - 0.64, v - 0.38) < 0.185) return ACCENT; // destination
  if (Math.hypot(u - 0.3, v - 0.72) < 0.065) return INK; // start
  // Dotted route from the start, curving up to the destination.
  for (const t of [0.27, 0.44, 0.6]) {
    const qx = 0.3 + 0.32 * t - 0.06 * Math.sin(Math.PI * t), qy = 0.72 - 0.32 * t - 0.06 * Math.sin(Math.PI * t);
    if (Math.hypot(u - qx, v - qy) < 0.032) return INK;
  }
  return BG;
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1)), px = draw(size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** An .ico holding PNG images (supported since Windows Vista). */
function ico(sizes) {
  const imgs = sizes.map(png), head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s; head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += imgs[i].length;
  });
  return Buffer.concat([head, ...imgs]);
}

fs.mkdirSync("packaging", { recursive: true });
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("packaging/icon.png", png(512));
fs.writeFileSync("packaging/icon.ico", ico([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync("public/favicon.png", png(64));
console.log("Wrote packaging/icon.png, packaging/icon.ico and public/favicon.png");
