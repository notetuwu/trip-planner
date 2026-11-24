// What a JPEG says about itself in its EXIF block: when it was taken, where (GPS), how it was held (orientation), and the
// small preview picture cameras store in it. Read from the first bytes of the file; no image library needed.
// (HEIC, which iPhones can save, keeps this elsewhere and isn't read here.)

export interface Exif {
  /** "2027-09-10T09:41:03", as the camera's clock wrote it. */
  t?: string;
  lat?: number;
  lng?: number;
  /** EXIF orientation 1-8 (1: as stored; 6: turn 90° clockwise to see it upright; 3: 180°; 8: 90° anticlockwise). */
  orientation?: number;
  /** The embedded preview (a small JPEG), stored unrotated. */
  thumb?: Buffer;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

export function readExif(buf: Buffer): Exif {
  const out: Exif = {};
  if (buf.length < 12 || buf[0] !== 0xff || buf[1] !== 0xd8) return out;
  // The segments after the start marker: find the APP1 that begins "Exif".
  let p = 2, tiff = -1, end = 0;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) break;
    const marker = buf[p + 1], len = buf.readUInt16BE(p + 2);
    if (marker === 0xda || marker === 0xd9) break; // the picture data: past the metadata
    if (marker === 0xe1 && buf.toString("latin1", p + 4, p + 10) === "Exif\0\0") { tiff = p + 10; end = Math.min(buf.length, p + 2 + len); break; }
    p += 2 + len;
  }
  if (tiff < 0) return out;
  const le = buf.toString("latin1", tiff, tiff + 2) === "II";
  if (!le && buf.toString("latin1", tiff, tiff + 2) !== "MM") return out;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(tiff + 2) !== 42) return out;

  /** The entries of the IFD at `off` (from the TIFF start): tag → [type, count, where its value is]. */
  const ifd = (off: number) => {
    const at = tiff + off, entries = new Map<number, { type: number; count: number; v: number }>();
    if (off <= 0 || at + 2 > end) return { entries, next: 0 };
    const n = u16(at);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > end) break;
      const type = u16(e + 2), count = u32(e + 4), size = (TYPE_SIZE[type] || 1) * count;
      // A value up to 4 bytes sits in the entry itself; a longer one is pointed to.
      entries.set(u16(e), { type, count, v: size <= 4 ? e + 8 : tiff + u32(e + 8) });
    }
    const nextAt = at + 2 + n * 12;
    return { entries, next: nextAt + 4 <= end ? u32(nextAt) : 0 };
  };
  const num = (e?: { type: number; v: number }) => (e ? (e.type === 3 ? u16(e.v) : u32(e.v)) : undefined);
  const text = (e?: { count: number; v: number }) => (e && e.v + e.count <= end ? buf.toString("latin1", e.v, e.v + e.count).replace(/\0.*$/, "").trim() : "");
  const rational = (o: number) => { const d = u32(o + 4); return d ? u32(o) / d : 0; };
  const when = (s: string) => (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(s) && !s.startsWith("0000") ? s.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T") : "");

  try {
    const i0 = ifd(u32(tiff + 4));
    const o = num(i0.entries.get(0x0112));
    if (o && o >= 1 && o <= 8) out.orientation = o;
    const exifPtr = num(i0.entries.get(0x8769)), gpsPtr = num(i0.entries.get(0x8825));
    const ex = exifPtr ? ifd(exifPtr) : null;
    const t = when(text(ex?.entries.get(0x9003))) || when(text(ex?.entries.get(0x9004))) || when(text(i0.entries.get(0x0132)));
    if (t) out.t = t;
    if (gpsPtr) {
      const g = ifd(gpsPtr).entries, la = g.get(0x0002), lo = g.get(0x0004);
      if (la && lo && la.count === 3 && lo.count === 3) {
        const deg = (e: { v: number }) => rational(e.v) + rational(e.v + 8) / 60 + rational(e.v + 16) / 3600;
        let lat = deg(la), lng = deg(lo);
        if (text(g.get(0x0001)).toUpperCase() === "S") lat = -lat;
        if (text(g.get(0x0003)).toUpperCase() === "W") lng = -lng;
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng)) { out.lat = +lat.toFixed(6); out.lng = +lng.toFixed(6); }
      }
    }
    // The second IFD describes the preview picture: where its JPEG is, and how long.
    if (i0.next) {
      const i1 = ifd(i0.next), off = num(i1.entries.get(0x0201)), len = num(i1.entries.get(0x0202));
      if (off && len && tiff + off + len <= end && buf[tiff + off] === 0xff && buf[tiff + off + 1] === 0xd8) out.thumb = buf.subarray(tiff + off, tiff + off + len);
    }
  } catch { /* a damaged block: what was read stands */ }
  return out;
}

/** Degrees to turn a picture stored as is (the preview) clockwise to see it upright, from its EXIF orientation. */
export const turnFor = (o?: number) => (o === 6 || o === 5 ? 90 : o === 3 || o === 4 ? 180 : o === 8 || o === 7 ? 270 : 0);
