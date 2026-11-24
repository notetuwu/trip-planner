// Day redos lined up from the problem review: you can keep going through the problems while the planner works on one
// day; the next starts when it's done. Each job builds its request only when its turn comes, from the plan as it is then
// (an earlier redo may already have fixed what it was for).
import { toast } from "../core/dom";
import type { Change } from "./request";
import { generationBusy, runGeneration } from "./run";

export interface Job {
  id: number;
  /** The days it changes (0-based). */
  days: number[];
  /** For the page: "Day 9", "Days 9, 12 and 14". */
  label: string;
  status: "queued" | "running";
  /** The request, made when the job starts; null when there's nothing left to do (then it's skipped). */
  build: () => Change | null;
}

const jobs: Job[] = [];
const listeners = new Set<() => void>();
let nextId = 1, pumping = false;

const notify = () => { for (const f of listeners) f(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls `f` whenever a job is added, starts or ends; returns the way to stop. */
export function onQueueChange(f: () => void) { listeners.add(f); return () => listeners.delete(f); }

/** What's lined up or running, first first. */
export const queuedJobs = (): readonly Job[] => jobs;

/** The job (lined up or running) that changes this day, if any. */
export const jobForDay = (day: number) => jobs.find((j) => j.days.includes(day));

export function enqueue(days: number[], label: string, build: Job["build"]) {
  if (days.some((d) => jobForDay(d))) { toast(`${label} is already lined up`); return; }
  jobs.push({ id: nextId++, days: [...days].sort((a, b) => a - b), label, status: "queued", build });
  notify();
  pump();
}

/** Takes a job off the line (not one that's already running: that one has its own Cancel). */
export function dequeue(id: number) {
  const i = jobs.findIndex((j) => j.id === id && j.status === "queued");
  if (i >= 0) { jobs.splice(i, 1); notify(); }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (jobs.length) {
      // Something else is being made (a whole new plan, a chat change): wait for it rather than fail.
      while (generationBusy()) await sleep(1000);
      const job = jobs[0];
      job.status = "running";
      notify();
      const change = job.build();
      if (change) await runGeneration(change);
      else toast(`${job.label}: nothing left to fix`);
      jobs.shift();
      notify();
    }
  } finally { pumping = false; }
}
