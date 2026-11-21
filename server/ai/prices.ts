// Anthropic API list prices (USD per million tokens), to show roughly what a plan cost. Unknown models show no cost.
const PER_MTOK: [RegExp, number, number][] = [
  [/fable-5-2|mythos-5-2/, 8, 40], [/fable|mythos/, 10, 50],
  [/opus-5-5/, 4, 20], [/opus-(5|4-[5-8])/, 5, 25], [/opus/, 15, 75],
  [/sonnet-5/, 2, 10], [/sonnet/, 3, 15],
  [/haiku-5-5/, 0.1, 0.5], [/haiku-4-5/, 1, 5], [/haiku/, 0.8, 4],
];
/** Web search is billed per search on top of tokens. */
const PER_SEARCH = 0.01;

export interface ClaudeUsage { input: number; cacheWrite: number; cacheRead: number; output: number; searches: number }

export function claudeCostUsd(model: string, u: ClaudeUsage): number | undefined {
  const price = PER_MTOK.find(([re]) => re.test(model));
  if (!price) return undefined;
  const [, inp, out] = price;
  return (u.input * inp + u.cacheWrite * inp * 1.25 + u.cacheRead * inp * 0.1 + u.output * out) / 1e6 + u.searches * PER_SEARCH;
}
