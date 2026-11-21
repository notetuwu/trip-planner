// Local thinking models sometimes get stuck saying the same thing over and over ("Is it a fortress? No. Is it a
// fortress? No. …") until they run out of room. This spots that in the streamed text so the request can be stopped
// early and retried another way, instead of burning minutes of GPU time.

const TAIL = 6000;
const CHECK_EVERY = 400;

/** Feed it the streamed text; returns true once the recent text is mostly one repeated piece. */
export function loopGuard() {
  let tail = "", sinceCheck = 0;
  return (piece: string): boolean => {
    tail = (tail + piece).slice(-TAIL);
    sinceCheck += piece.length;
    if (sinceCheck < CHECK_EVERY || tail.length < 1500) return false;
    sinceCheck = 0;
    return isLooping(tail);
  };
}

export function isLooping(text: string): boolean {
  // The same sentence again and again: of the last 40 sentences, one makes up at least half (and 10+ times).
  const sentences = text.split(/[.?!\n]+/).map((s) => s.trim().toLowerCase().replace(/\s+/g, " ")).filter((s) => s.length >= 8).slice(-40);
  if (sentences.length >= 20) {
    const counts = new Map<string, number>();
    for (const s of sentences) counts.set(s, (counts.get(s) || 0) + 1);
    const top = Math.max(...counts.values());
    if (top >= 10 && top >= sentences.length / 2) return true;
  }
  // The same stretch of text repeating without sentence breaks: the last 80 characters occur 6+ times in the tail.
  const end = text.slice(-80);
  if (end.trim().length < 20) return false;
  let n = 0, i = -1;
  while ((i = text.indexOf(end, i + 1)) !== -1) if (++n >= 6) return true;
  return false;
}
