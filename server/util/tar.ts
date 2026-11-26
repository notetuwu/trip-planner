// Reads one file out of a .tar.gz (enough for the Linux update, which ships as one). Handles plain and GNU long names.
import zlib from "node:zlib";

export function extractFromTarGz(tgz: Buffer, wanted: (name: string) => boolean): Buffer | null {
  const tar = zlib.gunzipSync(tgz);
  let p = 0, longName = "";
  while (p + 512 <= tar.length) {
    const head = tar.subarray(p, p + 512);
    if (head.every((b) => b === 0)) break; // the end
    const field = (at: number, len: number) => head.toString("utf8", at, at + len).replace(/\0[\s\S]*$/, "");
    const size = parseInt(field(124, 12).trim() || "0", 8), type = String.fromCharCode(head[156] || 48);
    const prefix = field(345, 155), body = tar.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = body.toString("utf8").replace(/\0[\s\S]*$/, ""); continue; } // GNU: the next entry's name
    const name = (longName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))).replace(/^\.\//, "");
    longName = "";
    if ((type === "0" || type === "\0") && wanted(name)) return Buffer.from(body);
  }
  return null;
}
