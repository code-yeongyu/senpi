/**
 * `schedule_prompt`: the model-callable surface for durable scheduled prompts.
 *
 * Unlike `/loop` (in-process timers, interactive only) this works in every run mode, including
 * `--print`: the tool only WRITES a job file and returns. Firing happens later in a separate
 * `senpi schedule run` process, so the job survives the scheduling process exiting.
 *
 * The TypeBox schema is a flat object with no root union (provider schema conversions rebuild tools
 * from top-level `properties`); per-action requirements are enforced in `execute`.
 */

import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../types.ts";
import { cancelScheduledJob } from "./occurrences.ts";
import { isWatchRunnerAvailable } from "./runner-lease.ts";
import { createScheduledJob, type JobRecord, listScheduledJobs, type ScheduledJobState, scheduleDir } from "./store.ts";
import {
	MAX_PENDING_JOBS_PER_SESSION,
	MAX_PENDING_JOBS_TOTAL,
	MAX_PROMPT_BYTES,
	MAX_SCHEDULE_AHEAD_MS,
	MIN_EVERY_SECONDS,
	type ScheduledJob,
} from "./types.ts";

export const SCHEDULE_PROMPT_TOOL = "schedule_prompt";

/** A due time this far in the past is almost certainly a mistake (wrong date or time zone). */
const PAST_TOLERANCE_MS = 60_000;
/** ISO 8601 date-time that names its instant: seconds optional, `Z` or a `+HH:MM` offset required. */
const ABSOLUTE_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export const SCHEDULE_PROMPT_DESCRIPTION = `Schedule a prompt to run later in THIS session: a reminder, a follow-up check, or a recurring task. The job is stored on disk and survives this process exiting (works in --print/headless runs). When it is due, a \`senpi schedule run\` runner delivers it back to this session as a new message that starts with "[Scheduled prompt <id> ...]".

- action "create": pass \`prompt\` (what to do or say when it fires, written as an instruction to your future self) and exactly one of \`delaySeconds\` or \`at\` (ISO 8601 date-time; include the UTC offset, e.g. 2026-09-28T09:00:00+09:00). Optional \`everySeconds\` (>= ${MIN_EVERY_SECONDS}) repeats it.
- action "list": this session's scheduled jobs.
- action "cancel": pass \`id\`. A delivery that has already started cannot be recalled; nothing after it runs.

If this session is open in another senpi process when a job is due, the default runner waits until it closes. Limits: prompt ${MAX_PROMPT_BYTES} bytes, ${MAX_PENDING_JOBS_PER_SESSION} pending jobs per session.`;

export const schedulePromptSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("cancel")], {
			description: "create a job, list this session's jobs, or cancel one by id.",
		}),
		prompt: Type.Optional(
			Type.String({ description: "create: the prompt delivered to this session when the job fires." }),
		),
		delaySeconds: Type.Optional(Type.Integer({ description: "create: fire this many seconds from now." })),
		at: Type.Optional(
			Type.String({ description: "create: absolute ISO 8601 date-time with UTC offset to fire at." }),
		),
		everySeconds: Type.Optional(
			Type.Integer({ description: `create: repeat every N seconds (minimum ${MIN_EVERY_SECONDS}).` }),
		),
		id: Type.Optional(Type.String({ description: "cancel: the job id (sch_...)." })),
	},
	{ additionalProperties: false },
);

export interface SchedulePromptParams {
	readonly action: "create" | "list" | "cancel";
	readonly prompt?: string;
	readonly delaySeconds?: number;
	readonly at?: string;
	readonly everySeconds?: number;
	readonly id?: string;
}

export interface SchedulePromptDetails {
	readonly action: SchedulePromptParams["action"];
	readonly jobs: readonly { readonly state: ScheduledJobState; readonly job: ScheduledJob }[];
	/** create: whether a live `senpi schedule run --watch` runner will pick the job up. */
	readonly runnerAvailable?: boolean;
	/** cancel: an occurrence was already being delivered and may still complete. */
	readonly inFlight?: boolean;
}

export interface SchedulePromptDeps {
	readonly now: () => number;
}

function describeJob(job: ScheduledJob, state: ScheduledJobState): string {
	const due = new Date(job.dueAt);
	const every = job.everyMs === null ? "" : `, every ${Math.round(job.everyMs / 1000)}s`;
	const error = job.lastError === null ? "" : `, last error: ${job.lastError}`;
	const prompt = job.prompt.length > 120 ? `${job.prompt.slice(0, 117)}...` : job.prompt;
	return `${job.id} [${state}] due ${due.toISOString()} (${due.toString()})${every}${error}: ${prompt}`;
}

function resolveDueAt(delaySeconds: number | undefined, at: string | undefined, now: number): number {
	const trimmedAt = at?.trim() ?? "";
	if ((delaySeconds === undefined) === (trimmedAt.length === 0)) {
		throw new Error("create needs exactly one of delaySeconds or at.");
	}
	if (delaySeconds !== undefined) {
		if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0) {
			throw new Error("delaySeconds must be a non-negative integer.");
		}
		return now + delaySeconds * 1000;
	}
	if (!ABSOLUTE_DATE_TIME.test(trimmedAt)) {
		throw new Error(
			`at must be an ISO 8601 date-time with Z or a UTC offset (e.g. 2026-09-28T09:00:00+09:00): ${trimmedAt}`,
		);
	}
	const dueAt = Date.parse(trimmedAt);
	if (!Number.isFinite(dueAt)) throw new Error(`at is not a valid date-time: ${trimmedAt}`);
	if (dueAt < now - PAST_TOLERANCE_MS) {
		throw new Error(`at (${new Date(dueAt).toISOString()}) is in the past; now is ${new Date(now).toISOString()}.`);
	}
	return dueAt;
}

function checkCapacity(jobs: readonly JobRecord[], sessionId: string): void {
	const pending = jobs.filter((record) => record.state === "pending");
	if (pending.length >= MAX_PENDING_JOBS_TOTAL) {
		throw new Error(`the schedule already holds ${MAX_PENDING_JOBS_TOTAL} pending jobs; cancel some first.`);
	}
	if (pending.filter((record) => record.job.sessionId === sessionId).length >= MAX_PENDING_JOBS_PER_SESSION) {
		throw new Error(`this session already has ${MAX_PENDING_JOBS_PER_SESSION} pending jobs; cancel some first.`);
	}
}

async function create(
	params: SchedulePromptParams,
	ctx: ExtensionContext,
	now: number,
): Promise<AgentToolResult<SchedulePromptDetails>> {
	const prompt = params.prompt?.trim() ?? "";
	if (prompt.length === 0) throw new Error("create needs a non-empty prompt.");
	if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
		throw new Error(`prompt must be at most ${MAX_PROMPT_BYTES} bytes.`);
	}
	const dueAt = resolveDueAt(params.delaySeconds, params.at, now);
	if (dueAt - now > MAX_SCHEDULE_AHEAD_MS) throw new Error("a job can be scheduled at most 366 days ahead.");
	let everyMs: number | null = null;
	if (params.everySeconds !== undefined) {
		if (!Number.isSafeInteger(params.everySeconds) || params.everySeconds < MIN_EVERY_SECONDS) {
			throw new Error(`everySeconds must be an integer of at least ${MIN_EVERY_SECONDS}.`);
		}
		if (params.everySeconds * 1000 > MAX_SCHEDULE_AHEAD_MS) {
			throw new Error(`everySeconds must be at most ${MAX_SCHEDULE_AHEAD_MS / 1000} (366 days).`);
		}
		everyMs = params.everySeconds * 1000;
	}
	const dir = scheduleDir(ctx.agentDir);
	const sessionId = ctx.sessionManager.getSessionId();
	checkCapacity((await listScheduledJobs(dir)).jobs, sessionId);
	const job = await createScheduledJob(
		dir,
		{ sessionId, sessionFile: ctx.sessionManager.getSessionFile() ?? null, cwd: ctx.cwd, prompt, dueAt, everyMs },
		now,
	);
	const runnerAvailable = await isWatchRunnerAvailable(dir, now);
	const lines = [`Scheduled ${describeJob(job, "pending")}`];
	lines.push(
		runnerAvailable
			? "A schedule runner is active; it will deliver the prompt to this session when due."
			: "No `senpi schedule run --watch` runner is active right now; the job fires the next time a runner runs.",
	);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { action: "create", jobs: [{ state: "pending", job }], runnerAvailable },
	};
}

async function list(ctx: ExtensionContext): Promise<AgentToolResult<SchedulePromptDetails>> {
	const sessionId = ctx.sessionManager.getSessionId();
	const { jobs } = await listScheduledJobs(scheduleDir(ctx.agentDir));
	const own = jobs.filter(({ job }) => job.sessionId === sessionId);
	const text =
		own.length === 0
			? "No scheduled jobs for this session."
			: own.map(({ state, job }) => describeJob(job, state)).join("\n");
	return { content: [{ type: "text", text }], details: { action: "list", jobs: own } };
}

async function cancel(
	params: SchedulePromptParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SchedulePromptDetails>> {
	const id = params.id?.trim() ?? "";
	if (id.length === 0) throw new Error("cancel needs the job id.");
	const removed = await cancelScheduledJob(scheduleDir(ctx.agentDir), id, {
		sessionId: ctx.sessionManager.getSessionId(),
	});
	if (removed === undefined) throw new Error(`No scheduled job ${id} in this session.`);
	const text = removed.inFlight
		? `Cancelled ${id}. One delivery had already started and may still arrive; nothing after it will run.`
		: `Cancelled ${describeJob(removed.job, "pending")}`;
	return {
		content: [{ type: "text", text }],
		details: { action: "cancel", jobs: [{ state: "pending", job: removed.job }], inFlight: removed.inFlight },
	};
}

export function registerScheduleTool(pi: ExtensionAPI, deps: SchedulePromptDeps): void {
	pi.registerTool({
		name: SCHEDULE_PROMPT_TOOL,
		label: "Schedule Prompt",
		description: SCHEDULE_PROMPT_DESCRIPTION,
		parameters: schedulePromptSchema,
		exposure: "search",
		searchKeywords: ["reminder", "remind", "later", "schedule", "cron", "timer", "alarm", "follow up", "recurring"],
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<SchedulePromptDetails>> {
			switch (params.action) {
				case "create":
					return create(params, ctx, deps.now());
				case "list":
					return list(ctx);
				case "cancel":
					return cancel(params, ctx);
			}
		},
	});
}
