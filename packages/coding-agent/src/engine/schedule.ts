import { runPasses, type ScheduleRunEvent } from "../cli/schedule-watch.ts";
import { cancelScheduledJob } from "../core/extensions/builtin/schedule/occurrences.ts";
import {
	type LiveRunner,
	liveRunners,
	RUNNER_HEARTBEAT_STALE_MS,
} from "../core/extensions/builtin/schedule/runner-lease.ts";
import {
	type InvalidJobFile,
	type JobRecord,
	listScheduledJobs,
	scheduleDir,
} from "../core/extensions/builtin/schedule/store.ts";
import { type EngineOk, type EngineResult, engineError, engineOk } from "./result.ts";

export type { ScheduleRunEvent } from "../cli/schedule-watch.ts";

export const SCHEDULE_RUN_DEFAULTS = { poll_seconds: 60, timeout_seconds: 900, concurrency: 4 } as const;

export interface ScheduleListing {
	/** When the listing was read; `fresh` on each runner is relative to it. */
	readonly observedAt: number;
	readonly jobs: readonly JobRecord[];
	readonly invalid: readonly InvalidJobFile[];
	readonly runners: readonly (LiveRunner & { readonly fresh: boolean })[];
}

/** Every scheduled prompt of every session, the job files that could not be read, and the live runners. */
export async function listSchedules(scope: { readonly agentDir: string }): Promise<EngineOk<ScheduleListing>> {
	const dir = scheduleDir(scope.agentDir);
	const { jobs, invalid } = await listScheduledJobs(dir);
	const observedAt = Date.now();
	const runners = (await liveRunners(dir)).map((runner) => ({
		...runner,
		fresh: observedAt - runner.beatAt <= RUNNER_HEARTBEAT_STALE_MS,
	}));
	return engineOk({ observedAt, jobs, invalid, runners });
}

export interface ScheduleCancelInput {
	readonly id: string;
}

/** Cancels a scheduled prompt for good; `inFlight` means one delivery had already started and may still complete. */
export async function cancelSchedule(
	scope: { readonly agentDir: string },
	input: ScheduleCancelInput,
): Promise<EngineResult<{ readonly id: string; readonly inFlight: boolean }, "not_found">> {
	const removed = await cancelScheduledJob(scheduleDir(scope.agentDir), input.id);
	if (removed === undefined) return engineError("not_found", `No scheduled prompt ${input.id}.`);
	return engineOk({ id: input.id, inFlight: removed.inFlight });
}

export interface ScheduleRunInput {
	/** Keep running until `signal` aborts, firing prompts as they come due. */
	readonly watch?: boolean;
	/** A shell command that receives each due prompt as JSON on stdin; without it the session is resumed headlessly. */
	readonly exec?: string;
	readonly poll_seconds?: number;
	readonly timeout_seconds?: number;
	readonly concurrency?: number;
	readonly signal?: AbortSignal;
}

export interface ScheduleRunOptions {
	/** Each delivery and runner event, in order, as it happens. */
	readonly onEvent: (event: ScheduleRunEvent) => void;
}

function positive(name: string, value: number | undefined, fallback: number): number | string {
	if (value === undefined) return fallback;
	return Number.isSafeInteger(value) && value >= 1 ? value : `${name} needs a positive integer`;
}

/** Fires the prompts that are due: one pass, or a watching runner. `failed` is a pass with a failed delivery. */
export async function runSchedule(
	scope: { readonly agentDir: string },
	input: ScheduleRunInput,
	options: ScheduleRunOptions,
): Promise<EngineResult<{ readonly failed: boolean }, "invalid_input">> {
	if (input.exec !== undefined && input.exec.trim().length === 0)
		return engineError("invalid_input", "exec needs a command");
	const pollSeconds = positive("poll_seconds", input.poll_seconds, SCHEDULE_RUN_DEFAULTS.poll_seconds);
	const timeoutSeconds = positive("timeout_seconds", input.timeout_seconds, SCHEDULE_RUN_DEFAULTS.timeout_seconds);
	const concurrency = positive("concurrency", input.concurrency, SCHEDULE_RUN_DEFAULTS.concurrency);
	for (const value of [pollSeconds, timeoutSeconds, concurrency]) {
		if (typeof value === "string") return engineError("invalid_input", value);
	}
	const succeeded = await runPasses(
		scheduleDir(scope.agentDir),
		{
			watch: input.watch === true,
			exec: input.exec,
			pollSeconds: Number(pollSeconds),
			timeoutSeconds: Number(timeoutSeconds),
			concurrency: Number(concurrency),
		},
		options.onEvent,
		input.signal,
	);
	return engineOk({ failed: !succeeded });
}
