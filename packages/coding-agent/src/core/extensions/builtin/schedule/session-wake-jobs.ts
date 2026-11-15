/**
 * `schedule_prompt` for a session whose loop keeps its wakes (a hosted loop's call on this machine, senpi#6754): a job
 * becomes a wake the loop arms as its own durable timer, never a file or a runner here. The wake carries the schedule
 * and the prompt only; when it comes due while no device can open the session, the loop keeps it pending.
 */
import { randomUUID } from "node:crypto";
import type { SessionWake, SessionWakePort } from "../../../session-wakes.ts";
import type { AgentToolResult, ExtensionContext } from "../../types.ts";
import type { SchedulePromptDetails } from "./tool.ts";
import { describeJob, MAX_PENDING_JOBS_PER_SESSION, SCHEDULED_JOB_VERSION, type ScheduledJob } from "./types.ts";

export interface WakeJob {
	readonly prompt: string;
	readonly dueAt: number;
	readonly everyMs: number | null;
}

/** A wake as the job the tool reports, so a hosted session sees what a local one sees. */
function jobOf(wake: SessionWake, ctx: ExtensionContext): ScheduledJob {
	return {
		version: SCHEDULED_JOB_VERSION,
		id: wake.id,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: null,
		cwd: ctx.cwd,
		prompt: wake.prompt,
		createdAt: wake.createdAt,
		dueAt: wake.dueAt,
		everyMs: wake.everyMs ?? null,
		fireCount: 0,
		lastFiredAt: null,
		lastError: null,
	};
}

const ownWakes = (wakes: SessionWakePort) => wakes.pending().filter((wake) => wake.source === "schedule_prompt");

export function armWakeJob(
	wakes: SessionWakePort,
	job: WakeJob,
	ctx: ExtensionContext,
	now: number,
): AgentToolResult<SchedulePromptDetails> {
	if (ownWakes(wakes).length >= MAX_PENDING_JOBS_PER_SESSION)
		throw new Error(`this session already has ${MAX_PENDING_JOBS_PER_SESSION} pending jobs; cancel some first.`);
	const wake: SessionWake = {
		id: `sch_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
		source: "schedule_prompt",
		dueAt: job.dueAt,
		...(job.everyMs === null ? {} : { everyMs: job.everyMs }),
		prompt: job.prompt,
		createdAt: now,
	};
	wakes.arm(wake);
	const scheduled = jobOf(wake, ctx);
	const text = [
		`Scheduled ${describeJob(scheduled, "pending")}`,
		"The session's host delivers the prompt to this session when it is due; while no device can open the session, it waits.",
	].join("\n");
	return {
		content: [{ type: "text", text }],
		details: { action: "create", jobs: [{ state: "pending", job: scheduled }] },
	};
}

export function listWakeJobs(wakes: SessionWakePort, ctx: ExtensionContext): AgentToolResult<SchedulePromptDetails> {
	const jobs = ownWakes(wakes).map((wake) => ({ state: "pending" as const, job: jobOf(wake, ctx) }));
	const text =
		jobs.length === 0
			? "No scheduled jobs for this session."
			: jobs.map(({ state, job }) => describeJob(job, state)).join("\n");
	return { content: [{ type: "text", text }], details: { action: "list", jobs } };
}

export function cancelWakeJob(
	wakes: SessionWakePort,
	id: string,
	ctx: ExtensionContext,
): AgentToolResult<SchedulePromptDetails> {
	const wake = ownWakes(wakes).find((pending) => pending.id === id);
	if (wake === undefined || !wakes.cancel(id)) throw new Error(`No scheduled job ${id} in this session.`);
	const job = jobOf(wake, ctx);
	return {
		content: [{ type: "text", text: `Cancelled ${describeJob(job, "pending")}` }],
		details: { action: "cancel", jobs: [{ state: "pending", job }], inFlight: false },
	};
}
