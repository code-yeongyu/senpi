/**
 * File-per-job store for durable scheduled prompts.
 *
 * Layout under `<agentDir>/schedule/` (the directory a file sits in IS its state):
 *
 *     pending/<id>.json               the job, waiting for its next due time
 *     firing/<id>@<n>~<owner>.json    occurrence <n> claimed by runner <owner> (`<pid>-<processStartMs>`)
 *     failed/<id>@<n>.json            occurrence <n> whose delivery failed or whose runner died mid-delivery
 *     cancelled/<id>                  tombstone: the job was cancelled; nothing may re-arm or deliver it
 *     runners/<pid>.json              lease + heartbeat of each live `senpi schedule run --watch`
 *
 * State transitions (claim, re-arm, settle, cancel) live in `occurrences.ts`.
 *
 * Every write is atomic (0600 temp file + rename, directories 0700). A runner claims an occurrence
 * by renaming `pending/<id>.json` to its occurrence record: rename is atomic on one filesystem, so
 * among racing runners exactly one wins and the others see ENOENT. A recurring job is re-armed in
 * `pending/` right after the claim, BEFORE delivery, so a runner crash can lose at most the one
 * in-flight occurrence, never the schedule. Cancellation writes the tombstone first and every
 * claim and re-arm re-checks it afterwards, so a cancelled job can never come back.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	InvalidScheduledJobError,
	MAX_JOB_FILE_BYTES,
	parseScheduledJob,
	SCHEDULED_JOB_VERSION,
	type ScheduledJob,
} from "./types.ts";

export type ScheduledJobState = "pending" | "firing" | "failed";

const STATE_DIRS: readonly ScheduledJobState[] = ["pending", "firing", "failed"];
const JOB_ID = /^sch_[a-z0-9]{12}$/;
/** `<id>`, `<id>@<n>` or `<id>@<n>~<pid>-<processStartMs>`, then `.json`. */
const RECORD_FILE = /^(sch_[a-z0-9]{12})(?:@(\d+)(?:~(\d+)-(\d+))?)?\.json$/;

export function scheduleDir(agentDir: string): string {
	return join(agentDir, "schedule");
}

export function isScheduledJobId(id: string): boolean {
	return JOB_ID.test(id);
}

export function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Atomic replace: a hidden 0600 temp file next to the target, then rename over it. */
export async function writeAtomic(filePath: string, contents: string): Promise<void> {
	await ensureDir(dirname(filePath));
	const tempPath = join(dirname(filePath), `.schedule-${randomUUID()}.tmp`);
	try {
		await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

export function serialize(job: ScheduledJob): string {
	return `${JSON.stringify(job, null, 2)}\n`;
}

/** Identity of the runner process that owns an occurrence record. */
export interface RunnerIdentity {
	readonly pid: number;
	readonly processStartedAtMs: number;
}

export interface JobRecord {
	readonly state: ScheduledJobState;
	readonly job: ScheduledJob;
	/** Store-relative path, e.g. `firing/sch_x@2~123-456.json`. */
	readonly file: string;
	/** Occurrence number for `firing` and `failed` records. */
	readonly occurrence?: number;
	/** Claiming runner of a `firing` record. */
	readonly owner?: RunnerIdentity;
}

export interface InvalidJobFile {
	readonly state: ScheduledJobState;
	readonly file: string;
	readonly error: string;
}

export interface JobListing {
	readonly jobs: readonly JobRecord[];
	readonly invalid: readonly InvalidJobFile[];
}

export async function readJobFile(path: string, expectedId: string): Promise<ScheduledJob> {
	const info = await stat(path);
	if (info.size > MAX_JOB_FILE_BYTES) {
		throw new InvalidScheduledJobError(`scheduled job file exceeds ${MAX_JOB_FILE_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) throw error;
		throw new InvalidScheduledJobError("scheduled job file is not valid JSON");
	}
	const job = parseScheduledJob(parsed);
	if (job.id !== expectedId) throw new InvalidScheduledJobError(`scheduled job id ${job.id} does not match its file`);
	return job;
}

/** Every record in every state, sorted by due time. Unreadable files are reported, never dropped. */
export async function listScheduledJobs(dir: string): Promise<JobListing> {
	const jobs: JobRecord[] = [];
	const invalid: InvalidJobFile[] = [];
	for (const state of STATE_DIRS) {
		let names: string[];
		try {
			names = await readdir(join(dir, state));
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) continue;
			throw error;
		}
		for (const name of names.sort()) {
			const match = RECORD_FILE.exec(name);
			if (match === null) continue;
			const [, id, occurrence, pid, startedAt] = match;
			const file = join(state, name);
			const shapeOk =
				state === "pending"
					? occurrence === undefined
					: state === "firing"
						? pid !== undefined
						: occurrence !== undefined && pid === undefined;
			if (!shapeOk || id === undefined) {
				invalid.push({ state, file, error: `unexpected record name for ${state}/` });
				continue;
			}
			try {
				const job = await readJobFile(join(dir, file), id);
				jobs.push({
					state,
					job,
					file,
					...(occurrence === undefined ? {} : { occurrence: Number(occurrence) }),
					...(pid === undefined || startedAt === undefined
						? {}
						: { owner: { pid: Number(pid), processStartedAtMs: Number(startedAt) } }),
				});
			} catch (error) {
				// A record claimed, settled or cancelled between readdir and read is simply gone.
				if (isFileSystemError(error, "ENOENT")) continue;
				invalid.push({ state, file, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	jobs.sort((a, b) => a.job.dueAt - b.job.dueAt);
	return { jobs, invalid };
}

export interface NewScheduledJob {
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
	readonly prompt: string;
	readonly dueAt: number;
	readonly everyMs: number | null;
}

export async function createScheduledJob(dir: string, input: NewScheduledJob, now: number): Promise<ScheduledJob> {
	const job = parseScheduledJob({
		version: SCHEDULED_JOB_VERSION,
		id: `sch_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
		...input,
		createdAt: now,
		fireCount: 0,
		lastFiredAt: null,
	});
	await writeAtomic(join(dir, "pending", `${job.id}.json`), serialize(job));
	return job;
}

export function tombstonePath(dir: string, id: string): string {
	return join(dir, "cancelled", id);
}

export async function isCancelled(dir: string, id: string): Promise<boolean> {
	try {
		await stat(tombstonePath(dir, id));
		return true;
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return false;
		throw error;
	}
}

export function runnersDir(dir: string): string {
	return join(dir, "runners");
}
