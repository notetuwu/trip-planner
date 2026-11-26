// Types for changelog.mjs (plain JavaScript, so the release workflow can run it without building).
import type { Change, Release } from "../shared/types";

export interface Commit extends Change { date: string; version: string }
export const LOG_FORMAT: string;
export function parseCommits(log: string): Commit[];
export function isNews(c: Commit): boolean;
export function releases(commits: Commit[]): Release[];
export function readChangelog(cwd: string): Release[];
