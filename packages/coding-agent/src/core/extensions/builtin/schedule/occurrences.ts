/**
 * State transitions of scheduled jobs: claim an occurrence, re-arm a recurring job, settle an
 * occurrence, cancel a job. Every transition that could bring a job back re-checks the job's
 * tombstone AFTER its write and undoes the write when a cancel won, so cancellation is final.
 */

import { randomUUID } from "node:crypto";
import { link, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ensureDir,
	isCancelled,
	isFileSystemError,
	isScheduledJobId,
	type JobListing,
	listScheduledJobs,
	type RunnerIdentity,
	readJobFile,
	serialize,
	tombstonePath,
	writeAtomic,
} from "./store.ts";
import { MAX_FAILED_RECORDS_PER_JOB, nextRecurringDueAt, type ScheduledJob } from "./types.ts";

const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface CancelResult {
	readonly job: ScheduledJob;
	/** True when an occurrence was already being delivered; that one delivery may still complete. */
	readonly inFlight: boolean;
	/** Failed occurrence records removed with the job. */
	readonly removedFailed: number;
}

/**
 * Cancels a job for good: writes its tombstone, then removes its pending job and failed records.
 * With `sessionId`, only that session's job may be cancelled. Returns undefined when no such job
 * exists (or it belongs to another session). An occurrence already being delivered cannot be
 * recalled; `inFlight` says so, and nothing after it will re-arm, deliver, or record the job.
 */
export async function cancelScheduledJob(
	dir: string,
	id: string,
	options: { readonly sessionId?: string } = {},
): Promise<CancelResult | undefined> {
	if (!isScheduledJobId(id)) return undefined;
	const records = (await listScheduledJobs(dir)).jobs.filter((record) => record.job.id === id);
	const representative = records.find((record) => record.state === "pending") ?? records[0];
	if (representative === undefined) return undefined;
	if (options.sessionId !== undefined && representative.job.sessionId !== options.sessionId) return undefined;
	await writeAtomic(tombstonePath(dir, id), `${new Date().toISOString()}\n`);
	// Read in-flight state only now: a claim that landed after the listing but before the tombstone
	// (its tombstone check came too early to see it) is on disk in firing/ by this point.
	const inFlight = (await occurrenceNumbers(dir, "firing", id)).length > 0;
	await rm(join(dir, "pending", `${id}.json`), { force: true });
	const failed = records.filter((record) => record.state === "failed");
	for (const record of failed) await rm(join(dir, record.file), { force: true });
	return {
		job: representative.job,
		inFlight,
		removedFailed: failed.length,
	};
}

export function occurrenceFile(id: string, occurrence: number, owner: RunnerIdentity): string {
	return join("firing", `${id}@${occurrence}~${owner.pid}-${owner.processStartedAtMs}.json`);
}

/**
 * Puts a record taken by mistake back into `pending/` without ever overwriting a pending file
 * (`link` fails with EEXIST instead), then re-checks the tombstone like every other re-arm.
 */
export async function restorePending(dir: string, record: string, id: string): Promise<void> {
	const pending = join(dir, "pending", `${id}.json`);
	try {
		await link(join(dir, record), pending);
	} catch (error) {
		if (!isFileSystemError(error, "EEXIST")) throw error;
	}
	await rm(join(dir, record), { force: true });
	if (await isCancelled(dir, id)) await rm(pending, { force: true });
}

/**
 * Claims occurrence `job.fireCount + 1` of a pending job for `owner` by an atomic rename.
 * Returns the store-relative occurrence record, or undefined when another runner claimed it first,
 * the job was cancelled, or the pending file is not the generation `job` describes (it is then put
 * back untouched).
 */
export async function claimOccurrence(
	dir: string,
	job: ScheduledJob,
	owner: RunnerIdentity,
): Promise<string | undefined> {
	const record = occurrenceFile(job.id, job.fireCount + 1, owner);
	await ensureDir(join(dir, "firing"));
	try {
		await rename(join(dir, "pending", `${job.id}.json`), join(dir, record));
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return undefined;
		throw error;
	}
	if (await isCancelled(dir, job.id)) {
		await rm(join(dir, record), { force: true });
		return undefined;
	}
	// The rename took whatever was pending; make sure it is the generation we meant to claim.
	const claimed = await readJobFile(join(dir, record), job.id);
	if (claimed.fireCount !== job.fireCount) {
		await restorePending(dir, record, job.id);
		return undefined;
	}
	return record;
}

/**
 * Re-arms a recurring job in `pending/` before its claimed occurrence is delivered. The tombstone
 * is re-checked after the write, so a cancel racing this re-arm always wins.
 */
export async function rearmRecurringJob(dir: string, next: ScheduledJob): Promise<void> {
	if (await isCancelled(dir, next.id)) return;
	const path = join(dir, "pending", `${next.id}.json`);
	await writeAtomic(path, serialize(next));
	if (await isCancelled(dir, next.id)) await rm(path, { force: true });
}

/** Occurrence numbers of the job's records in `state` (`firing/<id>@<n>~...`, `failed/<id>@<n>.json`). */
async function occurrenceNumbers(dir: string, state: "firing" | "failed", id: string): Promise<number[]> {
	let names: string[];
	try {
		names = await readdir(join(dir, state));
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return [];
		throw error;
	}
	const prefix = `${id}@`;
	return names
		.filter((name) => name.startsWith(prefix))
		.map((name) => Number.parseInt(name.slice(prefix.length), 10))
		.filter((occurrence) => Number.isSafeInteger(occurrence));
}

/**
 * Re-arms a recurring job whose runner died after claiming occurrence `occurrence` but before its
 * re-arm, so a crash in that window loses the occurrence, never the schedule. Nothing happens when
 * the job was cancelled, is pending again, or has a later occurrence on record (the re-arm ran);
 * the exclusive `link` never overwrites a pending file another runner restored first. Returns the
 * restored job.
 */
export async function restoreAbandonedSchedule(
	dir: string,
	job: ScheduledJob,
	occurrence: number,
	now: number,
): Promise<ScheduledJob | undefined> {
	if (job.everyMs === null || (await isCancelled(dir, job.id))) return undefined;
	const pending = join(dir, "pending", `${job.id}.json`);
	if (
		await stat(pending).then(
			() => true,
			() => false,
		)
	)
		return undefined;
	const later = [
		...(await occurrenceNumbers(dir, "firing", job.id)),
		...(await occurrenceNumbers(dir, "failed", job.id)),
	];
	if (later.some((n) => n > occurrence)) return undefined;
	const next: ScheduledJob = {
		...job,
		fireCount: occurrence,
		dueAt: nextRecurringDueAt(job.dueAt, job.everyMs, now),
		lastError: null,
	};
	await ensureDir(join(dir, "pending"));
	const temp = join(dir, "pending", `.schedule-${randomUUID()}.tmp`);
	try {
		await writeFile(temp, serialize(next), { encoding: "utf8", mode: 0o600 });
		await link(temp, pending);
	} catch (error) {
		if (!isFileSystemError(error, "EEXIST")) throw error;
		return undefined;
	} finally {
		await rm(temp, { force: true });
	}
	if (await isCancelled(dir, job.id)) {
		await rm(pending, { force: true });
		return undefined;
	}
	return next;
}

/**
 * Ends a claimed occurrence: removed on delivery, kept in `failed/` with the error otherwise -
 * unless the job was cancelled meanwhile, in which case nothing about it is kept.
 */
export async function settleOccurrence(
	dir: string,
	record: string,
	job: ScheduledJob,
	occurrence: number,
	outcome: { readonly ok: true } | { readonly ok: false; readonly error: string },
): Promise<void> {
	if (!outcome.ok && !(await isCancelled(dir, job.id))) {
		const failed = join(dir, "failed", `${job.id}@${occurrence}.json`);
		await writeAtomic(failed, serialize({ ...job, lastError: outcome.error }));
		if (await isCancelled(dir, job.id)) await rm(failed, { force: true });
		// A recurring job that keeps failing must not fill the disk: keep only its newest records.
		const older = (await occurrenceNumbers(dir, "failed", job.id)).sort((a, b) => b - a);
		for (const stale of older.slice(MAX_FAILED_RECORDS_PER_JOB)) {
			await rm(join(dir, "failed", `${job.id}@${stale}.json`), { force: true });
		}
	}
	await rm(join(dir, record), { force: true });
}

/** Removes tombstones older than a day whose job left no pending or firing record behind. */
export async function pruneTombstones(dir: string, listing: JobListing, now: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(join(dir, "cancelled"));
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return;
		throw error;
	}
	const live = new Set(listing.jobs.filter((record) => record.state !== "failed").map((record) => record.job.id));
	for (const id of names) {
		if (!isScheduledJobId(id) || live.has(id)) continue;
		const info = await stat(tombstonePath(dir, id)).catch(() => undefined);
		if (info !== undefined && now - info.mtimeMs > TOMBSTONE_RETENTION_MS) {
			await rm(tombstonePath(dir, id), { force: true });
		}
	}
}
