/**
 * When a job's widget spec is worth asking for: the pure part of the request controller. A job is
 * asked once it is old and talkative enough, again only when its spec stops fitting (drift) or a
 * task's subagent names what to watch, and never past its request cap.
 * Ported from oh-my-pi 9df0457b31 `job-widgets/registry.ts` (MIT, Copyright Can Boluk et al.).
 */
import type { JobWidgetBrief } from "./author-types.ts";
import type { JobWidgetSourceSample } from "./source-stats.ts";
import type { JobWidgetSpec } from "./spec-types.ts";

export interface JobWidgetRequestLimits {
	/** Job age before the first request. */
	readonly authorAfterMs: number;
	/** Non-empty lines one source needs before the first request. */
	readonly minLines: number;
	/** Author calls per job, retries included. */
	readonly maxRequestsPerJob: number;
	/** Jobs with a request in flight at once, per session. */
	readonly maxInFlight: number;
	/** Author calls per session in any {@link REQUEST_WINDOW_MS}. */
	readonly maxPerHour: number;
	/** Unmatched lines on the rules' sources that suggest the spec stopped fitting. */
	readonly driftLines: number;
	/** Age of the newest matched data past which drift re-authors. */
	readonly driftStaleMs: number;
}

export const JOB_WIDGET_REQUEST_LIMITS: JobWidgetRequestLimits = {
	authorAfterMs: 15_000,
	minLines: 3,
	maxRequestsPerJob: 3,
	maxInFlight: 2,
	maxPerHour: 30,
	driftLines: 200,
	driftStaleMs: 90_000,
};

export const REQUEST_WINDOW_MS = 60 * 60 * 1000;

/** What the controller reads of a job's derivation; `JobWidgetRuntime` satisfies it. */
export interface JobWidgetAuthoringSource {
	readonly spec: JobWidgetSpec | undefined;
	readonly unmatchedLines: number;
	readonly lastMatchAt: number | undefined;
	samples(): JobWidgetSourceSample[];
}

export interface JobWidgetRequestJob {
	readonly id: string;
	readonly startTime: number;
	readonly brief: JobWidgetBrief;
	readonly runtime: JobWidgetAuthoringSource;
}

/** One job's request bookkeeping; mutated by the controller as requests settle. */
export interface JobWidgetAuthoringState {
	requests: number;
	inFlight: boolean;
	/** No model can write specs, or no valid spec came of a full request: stop asking. */
	stopped: boolean;
	/**
	 * Set once the author declined: the task's `watch` hint at the time, `""` without one. A bash
	 * job is never asked again; a task job is asked again once its subagent names something else.
	 */
	skippedWatch?: string;
	/** Whether the installed spec was written knowing the task's `watch` hint. */
	specHadWatch: boolean;
}

export interface JobWidgetRequestPlan {
	readonly previous?: { readonly spec: JobWidgetSpec; readonly reason: string };
}

export function newAuthoringState(): JobWidgetAuthoringState {
	return { requests: 0, inFlight: false, stopped: false, specHadWatch: false };
}

function reauthorReason(
	job: JobWidgetRequestJob,
	state: JobWidgetAuthoringState,
	now: number,
	limits: JobWidgetRequestLimits,
): string | undefined {
	const { brief, runtime } = job;
	if (brief.watch && !state.specHadWatch) return `the subagent now says what to watch: ${brief.watch}`;
	if (runtime.unmatchedLines < limits.driftLines) return undefined;
	const newest = runtime.lastMatchAt;
	if (newest !== undefined && now - newest <= limits.driftStaleMs) return undefined;
	return `no rule matched the last ${runtime.unmatchedLines} lines`;
}

/**
 * The request a job is due, or `undefined`. A task job waits for its `watch` hint: most subagents
 * read and edit code, and only the subagent knows whether some output shows progress.
 */
export function planRequest(
	job: JobWidgetRequestJob,
	state: JobWidgetAuthoringState,
	now: number,
	limits: JobWidgetRequestLimits,
): JobWidgetRequestPlan | undefined {
	if (state.inFlight || state.stopped || state.requests >= limits.maxRequestsPerJob) return undefined;
	if (now - job.startTime < limits.authorAfterMs) return undefined;
	const { brief, runtime } = job;
	if (brief.kind === "task" && !brief.watch) return undefined;
	const skipped = state.skippedWatch;
	if (skipped !== undefined && (brief.kind === "bash" || skipped === brief.watch)) return undefined;
	if (runtime.spec) {
		const reason = reauthorReason(job, state, now, limits);
		return reason ? { previous: { spec: runtime.spec, reason } } : undefined;
	}
	return runtime.samples().some((sample) => sample.lines >= limits.minLines) ? {} : undefined;
}
