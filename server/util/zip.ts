// Reads one file out of a .zip (enough for the portable update, which ships as a zip). Handles stored and deflated
// entries; names may use / or \ (PowerShell's Compress-Archive writes backslashes).
import zlib from "node:zlib";

export function extractFromZip(zip: Buffer, wanted: (name: string) => boolean): Buffer | null {
  // The central directory's end record sits in the last 64 KB.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("Not a zip file");
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("Damaged zip file");
    const method = zip.readUInt16LE(p + 10), size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported zip compression (${method})`);
  }
  return null;
}
