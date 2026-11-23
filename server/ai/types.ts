import type { Place, RunResult, StreamEvent, TripRequest } from "../../shared/types";
import type { Holiday } from "../trip/holidays";
import type { NearbyList } from "../trip/nearby";

/** The trip request plus what the server gathered for it before planning. */
export interface Trip extends TripRequest {
  holidays?: Holiday[];
  /** Per stay (by index): sunrise and sunset there, filled in by the server. */
  daylight?: string[];
  nearby?: NearbyList[];
  researchNotes?: string;
  /** Road routes between consecutive stays travelled by road, by the arriving stay's index (null: no road route). */
  drives?: Record<number, { km: number; hours: number } | null>;
  /** Real train connections (between stays, from stops on the way, to day trips) as prompt lines; see trains.ts. */
  trains?: string[];
}

/** Progress events go to the browser as they happen (everything but the final "done"/"error"). */
export type OnEvent = (ev: Exclude<StreamEvent, { type: "done" } | { type: "error" }>) => void;

export type Runner = (trip: Trip, places: Place[], onEvent: OnEvent, abort: AbortSignal) => Promise<RunResult>;

/** How the travelers get somewhere, as the prompt phrases it. */
export const MODE_TEXT: Record<string, string> = {
  car: "by car (they drive themselves)", train: "by train", bus: "by bus or coach", flight: "by plane", ferry: "by ferry", bike: "by bike",
};
