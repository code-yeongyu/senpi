/**
 * The delivery contract between the schedule runner (`runner.ts`) and a delivery: what a delivery receives and
 * answers. The deliveries themselves (a `--exec` hook, a headless resume) live with the CLI.
 */

import { resolveMovedPath } from "../moved-path-guard/resolve.ts";
import type { ScheduledJob } from "./types.ts";

/** What a delivery hook receives on stdin, one JSON object. */
export interface ScheduledPromptEvent {
	readonly type: "scheduled_prompt";
	readonly id: string;
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
	/** The prompt exactly as scheduled. */
	readonly prompt: string;
	/** The prompt with a one-line provenance header; what the default delivery sends. */
	readonly message: string;
	readonly dueAt: number;
	readonly firedAt: number;
	readonly everyMs: number | null;
	/** Occurrence number, starting at 1. */
	readonly fireCount: number;
}

export type DeliveryResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly error: string;
			/** Nothing was delivered because another live process holds the session: retry later, not a failure. */
			readonly sessionHeld?: true;
	  };
/** Called with the delivery process pid as soon as it exists, so the session lock can record it. */
export interface DeliveryContext {
	readonly onSpawn?: (pid: number) => Promise<void>;
}
export type Delivery = (event: ScheduledPromptEvent, context?: DeliveryContext) => Promise<DeliveryResult>;
/** Returns a reason to leave a due job pending for now (for example: its session is open elsewhere). */
export type DeferProbe = (job: ScheduledJob) => Promise<string | undefined>;

// A job written before the desktop moved its data home fires against the moved files; its own file keeps the old paths (senpi#2898).
export function movedJobPaths(job: ScheduledJob): Pick<ScheduledJob, "sessionFile" | "cwd"> {
	return {
		sessionFile: job.sessionFile === null ? null : resolveMovedPath(job.sessionFile),
		cwd: resolveMovedPath(job.cwd),
	};
}
