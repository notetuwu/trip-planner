import type { Place, RunResult, StreamEvent, TripRequest } from "../../shared/types";
import type { Holiday } from "../trip/holidays";
import type { NearbyList } from "../trip/nearby";

/** The trip request plus what the server gathered for it before planning. */
export interface Trip extends TripRequest {
  holidays?: Holiday[];
  nearby?: NearbyList[];
  researchNotes?: string;
}

/** Progress events go to the browser as they happen (everything but the final "done"/"error"). */
export type OnEvent = (ev: Exclude<StreamEvent, { type: "done" } | { type: "error" }>) => void;

export type Runner = (trip: Trip, places: Place[], onEvent: OnEvent, abort: AbortSignal) => Promise<RunResult>;

/** How the travelers get somewhere, as the prompt phrases it. */
export const MODE_TEXT: Record<string, string> = {
  car: "by car (they drive themselves)", train: "by train", bus: "by bus or coach", flight: "by plane", ferry: "by ferry", bike: "by bike",
};
