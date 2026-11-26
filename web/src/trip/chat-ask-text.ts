// A reply with a question to pick an answer to often ends by asking it in words too: shown once, in the question.

/** The text without the question (or questions) it ends on. */
export function withoutClosingQuestion(text: string): string {
  let out = String(text || "").trimEnd();
  // The last sentence of the last line, when it's a question: from the start of the line or the sentence before.
  const last = /(^|\n|[.!?:][*_)]*[ \t]+)(?:(?![.!?][*_)]*[ \t])[^\n])*\?[*_) \t]*$/;
  for (let m = last.exec(out); m; m = last.exec(out)) {
    out = out.slice(0, m.index + (m[1] === "\n" ? 0 : m[1].length)).trimEnd();
  }
  return out;
}
