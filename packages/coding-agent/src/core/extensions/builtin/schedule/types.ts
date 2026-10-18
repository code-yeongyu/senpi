/**
 * Data model for durable scheduled prompts.
 *
 * A scheduled prompt outlives the process that created it: it is one JSON file in the
 * agent directory, written by the `schedule_prompt` tool from ANY run mode (interactive, RPC,
 * `--print`), and fired later by a separate `senpi schedule run` process. Nothing here touches
 * the clock or the filesystem.
 */

export const SCHEDULED_JOB_VERSION = 1;

/** Shortest recurrence accepted; a runner polls, so tighter cadences would only drift. */
export const MIN_EVERY_SECONDS = 60;
/** Farthest a job may be scheduled ahead of its creation. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/** Largest prompt a job may carry, in UTF-8 bytes. */
export const MAX_PROMPT_BYTES = 16 * 1024;
/** Job files larger than this are reported as invalid without being parsed. */
export const MAX_JOB_FILE_BYTES = 64 * 1024;
/** Pending jobs one session may hold at once. */
export const MAX_PENDING_JOBS_PER_SESSION = 50;
/** Pending jobs the whole agent directory may hold at once. */
export const MAX_PENDING_JOBS_TOTAL = 1000;
/** Failed occurrence records kept per job; older ones are removed as new failures arrive. */
export const MAX_FAILED_RECORDS_PER_JOB = 10;

export interface ScheduledJob {
	readonly version: typeof SCHEDULED_JOB_VERSION;
	readonly id: string;
	/** Session that scheduled the prompt; a fired prompt belongs to it. */
	readonly sessionId: string;
	/** Session file at creation time, when the session was persisted. */
	readonly sessionFile: string | null;
	/** Working directory of the scheduling session. */
	readonly cwd: string;
	/** Exact text to deliver when the job fires. */
	readonly prompt: string;
	readonly createdAt: number;
	/** Next wall-clock time the job is due, epoch ms. */
	readonly dueAt: number;
	/** Recurrence period in ms, or null for a one-shot job. */
	readonly everyMs: number | null;
	readonly fireCount: number;
	readonly lastFiredAt: number | null;
	/** Delivery error; set only on the occurrence records in `failed/`. */
	readonly lastError: string | null;
}

export class InvalidScheduledJobError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidScheduledJobError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(raw: Record<string, unknown>, key: string): string {
	const value = raw[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new InvalidScheduledJobError(`scheduled job field "${key}" must be a non-empty string`);
	}
	return value;
}

/** Epoch milliseconds or counters: non-negative safe integers only. */
function requireCount(raw: Record<string, unknown>, key: string): number {
	const value = raw[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new InvalidScheduledJobError(`scheduled job field "${key}" must be a non-negative integer`);
	}
	return value;
}

function nullableCount(raw: Record<string, unknown>, key: string): number | null {
	return raw[key] === null || raw[key] === undefined ? null : requireCount(raw, key);
}

function nullableString(raw: Record<string, unknown>, key: string): string | null {
	const value = raw[key];
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new InvalidScheduledJobError(`scheduled job field "${key}" must be a string`);
	return value;
}

/** Validates one parsed job. Fails closed: a malformed job is reported, never fired. */
export function parseScheduledJob(raw: unknown): ScheduledJob {
	if (!isRecord(raw)) throw new InvalidScheduledJobError("scheduled job must be a JSON object");
	if (raw.version !== SCHEDULED_JOB_VERSION) {
		throw new InvalidScheduledJobError(`unsupported scheduled job version: ${JSON.stringify(raw.version)}`);
	}
	const id = requireString(raw, "id");
	if (!/^sch_[a-z0-9]{12}$/.test(id)) throw new InvalidScheduledJobError(`invalid scheduled job id: ${id}`);
	const everyMs = nullableCount(raw, "everyMs");
	if (everyMs !== null && everyMs < MIN_EVERY_SECONDS * 1000) {
		throw new InvalidScheduledJobError(`scheduled job recurrence must be at least ${MIN_EVERY_SECONDS}s`);
	}
	if (everyMs !== null && everyMs > MAX_SCHEDULE_AHEAD_MS) {
		throw new InvalidScheduledJobError("scheduled job recurrence must be at most 366 days");
	}
	const prompt = requireString(raw, "prompt");
	if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
		throw new InvalidScheduledJobError(`scheduled job prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
	}
	const createdAt = requireCount(raw, "createdAt");
	const dueAt = requireCount(raw, "dueAt");
	return {
		version: SCHEDULED_JOB_VERSION,
		id,
		sessionId: requireString(raw, "sessionId"),
		sessionFile: nullableString(raw, "sessionFile"),
		cwd: requireString(raw, "cwd"),
		prompt,
		createdAt,
		dueAt,
		everyMs,
		fireCount: requireCount(raw, "fireCount"),
		lastFiredAt: nullableCount(raw, "lastFiredAt"),
		lastError: nullableString(raw, "lastError"),
	};
}

/** First occurrence of a recurring job strictly after `now`; missed occurrences collapse into it. */
export function nextRecurringDueAt(dueAt: number, everyMs: number, now: number): number {
	if (dueAt > now) return dueAt;
	const missed = Math.floor((now - dueAt) / everyMs) + 1;
	return dueAt + missed * everyMs;
}

/** Text the fired prompt is delivered as: a one-line provenance header, then the prompt verbatim. */
export function formatScheduledMessage(job: ScheduledJob, firedAt: number): string {
	const recurrence = job.everyMs === null ? "" : `, repeats every ${Math.round(job.everyMs / 1000)}s`;
	return `[Scheduled prompt ${job.id}: created ${new Date(job.createdAt).toISOString()}, due ${new Date(job.dueAt).toISOString()}, fired ${new Date(firedAt).toISOString()}${recurrence}]\n${job.prompt}`;
}
