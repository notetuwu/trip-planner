// Reading where and when a video was recorded, from the file's own header, wherever the file is (a Drive file, read by small
// range requests, or one on this computer). Phones write the position ("©xyz", or Apple's ISO 6709 location) and the
// recording time (the movie header's creation date, in UTC) into the MP4/MOV header (the "moov" atom), which sits after
// the picture data. It's found by hopping from atom to atom with small reads (a few bytes each), then reading just that
// header: not the video.

/** A time from a file name: "IMG_20270910_094103.jpg", "PXL_20270910_094103123.mp4", "2027-09-10 09.41.03.mov" → "2027-09-10T09:41:03". */
export function timeFromName(name: string): string {
  const m = /(?<!\d)((?:19[89]|20[0-9])\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[-_ T.]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d)(?:\d{3})?(?!\d)/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : "";
}

/** The position and recording time in a movie header ("moov" atom's bytes). */
export function readMoov(buf: Buffer): { lat?: number; lng?: number; created?: number } {
  const text = buf.toString("latin1"), out: { lat?: number; lng?: number; created?: number } = {};
  // "+47.0502+008.3093+420.000/" (ISO 6709): after the "©xyz" atom's name (Android and most cameras), or after Apple's
  // "com.apple.quicktime.location.ISO6709" key.
  for (const marker of ["\xa9xyz", "ISO6709"]) {
    const i = text.indexOf(marker);
    if (i < 0) continue;
    const m = /([+-]\d{1,3}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/.exec(text.slice(i + marker.length, i + marker.length + 140));
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180 && (+m[1] || +m[2])) { out.lat = +(+m[1]).toFixed(6); out.lng = +(+m[2]).toFixed(6); break; }
  }
  // The movie header: version, flags, then the creation time in seconds since 1904 (32 or 64 bits).
  const mv = buf.indexOf("mvhd");
  if (mv >= 0 && mv + 16 <= buf.length) {
    const v = buf[mv + 4], secs = v === 1 ? Number(buf.readBigUInt64BE(mv + 8)) : buf.readUInt32BE(mv + 8), unix = secs - 2082844800;
    if (unix > 946684800 && unix < 4102444800) out.created = unix;
  }
  return out;
}

/** The recording time (UTC, unix seconds) as the local time at a longitude: close (a zone is about 15° wide; daylight
 *  saving isn't known), which is enough to tell the day and about the hour. */
export function localTime(unix: number, lng?: number): string {
  const d = new Date((unix + (lng != null ? Math.round(lng / 15) * 3600 : 0)) * 1000);
  return d.toISOString().slice(0, 19);
}


/** Reads `len` bytes of the file from `start` (fewer at its end; null past it). */
export type Reader = (start: number, len: number) => Promise<Buffer | null>;

/** How long the movie is, in seconds (from the movie header's time scale and duration). */
export function readDuration(buf: Buffer): number | undefined {
  const mv = buf.indexOf("mvhd");
  if (mv < 0) return undefined;
  const v = buf[mv + 4], need = v === 1 ? mv + 36 : mv + 24;
  if (need > buf.length) return undefined;
  const scale = buf.readUInt32BE(v === 1 ? mv + 24 : mv + 16), dur = v === 1 ? Number(buf.readBigUInt64BE(mv + 28)) : buf.readUInt32BE(mv + 20);
  return scale > 0 && dur > 0 && dur / scale < 86400 ? Math.round(dur / scale) : undefined;
}

export interface VideoHeader { lat?: number; lng?: number; /** Recording time, as local time where it was shot. */ t?: string; dur?: number }

/** Finds the "moov" atom by hopping over the others (each starts with its size and name) and reads it. */
export async function readVideoHeader(read: Reader): Promise<VideoHeader> {
  let pos = 0;
  for (let hops = 0; hops < 12; hops++) {
    const head = await read(pos, 16);
    if (!head || head.length < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    if (size === 1 && head.length >= 16) size = Number(head.readBigUInt64BE(8));
    if (type === "moov") {
      if (size > 24 * 1024 * 1024) break;
      const moov = await read(pos, size);
      if (!moov) break;
      const m = readMoov(moov), dur = readDuration(moov);
      return { ...(m.lat != null ? { lat: m.lat, lng: m.lng } : {}), ...(m.created ? { t: localTime(m.created, m.lng) } : {}), ...(dur ? { dur } : {}) };
    }
    if (size < 8) break;
    pos += size;
  }
  return {};
}
