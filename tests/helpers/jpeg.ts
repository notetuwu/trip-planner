// A JPEG with an EXIF block, for the tests of what's read from pictures.

/** A JPEG with an EXIF block (big-endian): orientation 6, taken 2027-09-10 09:41:03 at 47°3'0.72"N 8°18'33.48"E (S/W
 *  with `south`/`west`), and a 10-byte "preview". */
export function jpeg({ south = false, west = false, withGps = true } = {}) {
  const t = Buffer.alloc(300);
  let at = 0;
  const w16 = (v: number) => { t.writeUInt16BE(v, at); at += 2; };
  const w32 = (v: number) => { t.writeUInt32BE(v, at); at += 4; };
  const entry = (tag: number, type: number, count: number, value: number | string) => {
    w16(tag); w16(type); w32(count);
    if (typeof value === "string") { t.write(value, at, "latin1"); at += 4; } else w32(type === 3 ? value * 0x10000 : value);
  };
  t.write("MM", 0); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
  at = 8;
  // IFD0 @8: orientation, the Exif IFD, the GPS IFD; then the next IFD (the preview's) @190.
  w16(withGps ? 3 : 2); entry(0x0112, 3, 1, 6); entry(0x8769, 4, 1, 50); if (withGps) entry(0x8825, 4, 1, 68); w32(withGps ? 190 : 0);
  at = 50; w16(1); entry(0x9003, 2, 20, "") ; t.writeUInt32BE(122, at - 4); w32(0);
  at = 68;
  w16(4); entry(0x0001, 2, 2, south ? "S\0" : "N\0"); entry(0x0002, 5, 3, 142); entry(0x0003, 2, 2, west ? "W\0" : "E\0"); entry(0x0004, 5, 3, 166); w32(0);
  t.write("2027:09:10 09:41:03\0", 122, "latin1");
  const rats = (off: number, vals: [number, number][]) => vals.forEach(([n, d], i) => { t.writeUInt32BE(n, off + i * 8); t.writeUInt32BE(d, off + i * 8 + 4); });
  rats(142, [[47, 1], [3, 1], [72, 100]]); rats(166, [[8, 1], [18, 1], [3348, 100]]);
  at = 190; w16(2); entry(0x0201, 4, 1, 220); entry(0x0202, 4, 1, 10); w32(0);
  Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]).copy(t, 220);
  const tiff = t.subarray(0, 230), head = Buffer.alloc(12);
  head.writeUInt16BE(0xffd8, 0); head.writeUInt16BE(0xffe1, 2); head.writeUInt16BE(2 + 6 + tiff.length, 4); head.write("Exif\0\0", 6, "latin1");
  return Buffer.concat([head, tiff, Buffer.from([0xff, 0xd9])]);
}
