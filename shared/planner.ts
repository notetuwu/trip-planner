// What the checked planner (server/ai/checked, Settings → Plan style → Planner) and the browser agree on: how big a
// day is, and how a plan made by it is recognised (its engine name), so the browser's own checks ask the same.

/** Marks a plan made by the checked planner in RunResult.engine ("qwen3.8:27b (Ollama, checked planner)"). */
export const CHECKED_ENGINE = /checked planner/;

export type Pace = "relaxed" | "balanced" | "packed";

/** The pace a trip's pace text ("balanced (3-5 stops per day)") stands for. */
export const paceOf = (text: string | undefined): Pace =>
  (/^\s*relaxed/i.test(text || "") ? "relaxed" : /^\s*packed/i.test(text || "") ? "packed" : "balanced");

/**
 * Substantive sights or activities on a day, by pace: one definition for prompts and checks. Meals, transfers,
 * check-in/out and the hotel don't count; a big sight that takes hours counts once. These are guidelines, never quotas:
 * a day is never filled up to reach them.
 */
export const DAY_SIZE: Record<Pace, { full: [number, number]; travel: [number, number] }> = {
  relaxed: { full: [2, 3], travel: [0, 1] },
  balanced: { full: [3, 4], travel: [1, 2] },
  packed: { full: [4, 6], travel: [1, 2] },
};

/** Day trips farther than this (driving minutes from where they sleep) belong on full days, not travel days. */
export const DAY_TRIP_MINUTES = 45;
