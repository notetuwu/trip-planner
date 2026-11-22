// Local thinking models sometimes get stuck saying the same thing over and over ("Is it a fortress? No. Is it a
// fortress? No. …") until they run out of room. This spots that in the streamed text so the request can be stopped
// early and retried another way, instead of burning minutes of GPU time.

// Long enough to hold a few rounds of a long loop (one round of "let me check everything again" can be 2,000+ characters).
const TAIL = 20000;
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
  // The same block over and over, back to back: a short one ("Is it a fortress? No. ") 4+ times, or a long round of
  // "final checks" 3 times. Only back to back: a long itinerary repeats plenty of text (the same breakfast at the hotel
  // every morning, the same fields on every stop), but with other things in between.
  return repeatsAtEnd(text, 80, 4) || repeatsAtEnd(text, 300, 3);
}

/** For the itinerary JSON (not the thinking): it's held to a schema and full of similar stops, so only a long block
 *  repeated back to back five times counts as a loop (a real runaway ends at the context limit anyway). */
export function jsonLoopGuard() {
  let tail = "", sinceCheck = 0;
  return (piece: string): boolean => {
    tail = (tail + piece).slice(-TAIL);
    sinceCheck += piece.length;
    if (sinceCheck < 2000 || tail.length < 4000) return false;
    sinceCheck = 0;
    return repeatsAtEnd(tail, 400, 5);
  };
}

/** The text ends with one block repeated `times` times in a row; the block is found from the last `win` characters. */
export function repeatsAtEnd(text: string, win: number, times: number): boolean {
  const end = text.slice(-win);
  if (end.trim().length < Math.min(20, win / 2) || text.length < win * 2) return false;
  const prev = text.lastIndexOf(end, text.length - win - 1);
  if (prev < 0) return false;
  const period = text.length - win - prev;
  if (period < 1 || period * times > text.length) return false;
  const block = text.slice(-period);
  for (let k = 2; k <= times; k++) if (text.slice(-k * period, -(k - 1) * period) !== block) return false;
  return true;
}
