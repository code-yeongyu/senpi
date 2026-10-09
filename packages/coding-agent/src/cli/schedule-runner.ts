/**
 * Fires due scheduled prompts for `senpi schedule run`. The clock, the delivery, and the "is the
 * session busy" probe are injected, so every rule here is testable without real waiting or processes.
 *
 * One pass: recover occurrences whose runner died mid-delivery (they move to `failed/`, never
 * re-delivered: at-most-once), then claim and deliver due jobs - concurrently across sessions up to
 * `concurrency`, strictly one at a time within a session.
 */

import { join } from "node:path";
import {
	claimOccurrence,
	pruneTombstones,
	rearmRecurringJob,
	restoreAbandonedSchedule,
	restorePending,
	settleOccurrence,
} from "../core/extensions/builtin/schedule/occurrences.ts";
import {
	acquireSessionDeliveryLock,
	isOwnerAmong,
	type LiveRunner,
	liveRunners,
} from "../core/extensions/builtin/schedule/runner-lease.ts";
import {
	type InvalidJobFile,
	isCancelled,
	type JobRecord,
	listScheduledJobs,
	type RunnerIdentity,
	readJobFile,
} from "../core/extensions/builtin/schedule/store.ts";
import {
	formatScheduledMessage,
	nextRecurringDueAt,
	type ScheduledJob,
} from "../core/extensions/builtin/schedule/types.ts";
import { type DeferProbe, type Delivery, type DeliveryResult, movedJobPaths } from "./schedule-delivery.ts";

export type RunnerEvent =
	| {
			readonly event: "fired";
			readonly id: string;
			readonly sessionId: string;
			readonly occurrence: number;
			readonly outcome: "delivered" | "failed";
			readonly error?: string;
			readonly firedAt: number;
			readonly dueAt: number;
			readonly nextDueAt?: number;
	  }
	| { readonly event: "deferred"; readonly id: string; readonly sessionId: string; readonly reason: string }
	| {
			readonly event: "abandoned";
			readonly id: string;
			readonly sessionId: string;
			readonly occurrence: number;
			readonly error: string;
	  }
	| ({ readonly event: "invalid" } & InvalidJobFile)
	| {
			readonly event: "error";
			/** The job being handled, when the error belongs to one; absent for a failed pass. */
			readonly id?: string;
			readonly sessionId?: string;
			readonly error: string;
	  };

export interface RunDueResult {
	readonly events: readonly RunnerEvent[];
	/** Earliest due time among jobs still pending after this pass. */
	readonly nextDueAt: number | undefined;
}

/** How long a deferred job waits before the next attempt (a shorter poll interval still wins). */
export const DEFERRED_RETRY_MS = 15_000;

export const ABANDONED_OCCURRENCE_ERROR =
	"the runner exited while delivering this occurrence; outcome unknown, not retried";

export interface RunDueOptions {
	readonly dir: string;
	readonly now: () => number;
	readonly deliver: Delivery;
	readonly owner: RunnerIdentity;
	readonly concurrency?: number;
	/** Delivery time limit, recorded in the session lock for ungated (Windows) deliveries. */
	readonly deliveryTimeoutMs?: number;
	readonly shouldDefer?: DeferProbe;
	/** Live runners, for recovering occurrences of dead ones; defaults to reading the leases. */
	readonly runners?: () => Promise<readonly LiveRunner[]>;
}

interface Recovery {
	readonly events: RunnerEvent[];
	/** Due times of recurring jobs re-armed because their runner died before re-arming them. */
	readonly restoredDueAt: number[];
}

async function recoverAbandoned(options: RunDueOptions, records: readonly JobRecord[]): Promise<Recovery> {
	const firing = records.filter((record) => record.state === "firing");
	if (firing.length === 0) return { events: [], restoredDueAt: [] };
	const runners = await (options.runners ?? (() => liveRunners(options.dir)))();
	const events: RunnerEvent[] = [];
	const restoredDueAt: number[] = [];
	for (const record of firing) {
		if (record.owner === undefined || record.occurrence === undefined) continue;
		const mine =
			record.owner.pid === options.owner.pid && record.owner.processStartedAtMs === options.owner.processStartedAtMs;
		if (mine || isOwnerAmong(record.owner, runners)) continue;
		// Before the record goes: a runner that died before its re-arm must not take the schedule with it.
		const restored = await restoreAbandonedSchedule(options.dir, record.job, record.occurrence, options.now());
		if (restored !== undefined) restoredDueAt.push(restored.dueAt);
		await settleOccurrence(options.dir, record.file, record.job, record.occurrence, {
			ok: false,
			error: ABANDONED_OCCURRENCE_ERROR,
		});
		events.push({
			event: "abandoned",
			id: record.job.id,
			sessionId: record.job.sessionId,
			occurrence: record.occurrence,
			error: ABANDONED_OCCURRENCE_ERROR,
		});
	}
	return { events, restoredDueAt };
}

/** Re-reads a pending job under the session lock; undefined when it is gone, cancelled, or not due. */
async function freshPendingJob(options: RunDueOptions, id: string): Promise<ScheduledJob | undefined> {
	const job = await readJobFile(join(options.dir, "pending", `${id}.json`), id).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (job === undefined || job.dueAt > options.now() || (await isCancelled(options.dir, id))) return undefined;
	return job;
}

async function fireOne(options: RunDueOptions, listed: ScheduledJob): Promise<RunnerEvent | undefined> {
	const lock = await acquireSessionDeliveryLock(options.dir, listed.sessionId, {
		maxDeliveryMs: options.deliveryTimeoutMs,
	});
	if (!lock.acquired) {
		const holder = lock.heldByPid === undefined ? "another runner" : `process ${lock.heldByPid}`;
		return {
			event: "deferred",
			id: listed.id,
			sessionId: listed.sessionId,
			reason: `${holder} is delivering to this session`,
		};
	}
	try {
		const job = await freshPendingJob(options, listed.id);
		if (job === undefined) return undefined;
		const deferReason = await options.shouldDefer?.({ ...job, ...movedJobPaths(job) });
		if (deferReason !== undefined)
			return { event: "deferred", id: job.id, sessionId: job.sessionId, reason: deferReason };
		return await deliverClaimed(options, job, (pid) => lock.attachDelivery(pid));
	} finally {
		await lock.release();
	}
}

async function deliverClaimed(
	options: RunDueOptions,
	job: ScheduledJob,
	onSpawn: (pid: number) => Promise<void>,
): Promise<RunnerEvent | undefined> {
	const record = await claimOccurrence(options.dir, job, options.owner);
	if (record === undefined) return undefined;
	const occurrence = job.fireCount + 1;
	const firedAt = options.now();
	let nextDueAt: number | undefined;
	if (job.everyMs !== null) {
		nextDueAt = nextRecurringDueAt(job.dueAt, job.everyMs, firedAt);
		// Re-arm BEFORE delivering: a crash from here on loses at most this one occurrence.
		try {
			await rearmRecurringJob(options.dir, {
				...job,
				fireCount: occurrence,
				lastFiredAt: firedAt,
				dueAt: nextDueAt,
			});
		} catch (error) {
			// Nothing was delivered: put the claimed generation back so the schedule survives the error.
			await restorePending(options.dir, record, job.id);
			throw error;
		}
	}
	let result: DeliveryResult;
	try {
		result = await options.deliver(
			{
				type: "scheduled_prompt",
				id: job.id,
				sessionId: job.sessionId,
				...movedJobPaths(job),
				prompt: job.prompt,
				message: formatScheduledMessage(job, firedAt),
				dueAt: job.dueAt,
				firedAt,
				everyMs: job.everyMs,
				fireCount: occurrence,
			},
			{ onSpawn },
		);
	} catch (error) {
		result = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	await settleOccurrence(
		options.dir,
		record,
		{ ...job, fireCount: occurrence, lastFiredAt: firedAt },
		occurrence,
		result,
	);
	return {
		event: "fired",
		id: job.id,
		sessionId: job.sessionId,
		occurrence,
		outcome: result.ok ? "delivered" : "failed",
		...(result.ok ? {} : { error: result.error }),
		firedAt,
		dueAt: job.dueAt,
		...(nextDueAt === undefined || (await isCancelled(options.dir, job.id)) ? {} : { nextDueAt }),
	};
}

export async function runDueJobs(options: RunDueOptions): Promise<RunDueResult> {
	const listing = await listScheduledJobs(options.dir);
	const events: RunnerEvent[] = listing.invalid.map((invalid) => ({ event: "invalid", ...invalid }));
	const recovery = await recoverAbandoned(options, listing.jobs);
	events.push(...recovery.events);
	await pruneTombstones(options.dir, listing, options.now());

	let nextDueAt: number | undefined;
	const noteNext = (dueAt: number) => {
		nextDueAt = nextDueAt === undefined ? dueAt : Math.min(nextDueAt, dueAt);
	};
	for (const dueAt of recovery.restoredDueAt) noteNext(dueAt);
	const bySession = new Map<string, ScheduledJob[]>();
	for (const { state, job } of listing.jobs) {
		if (state !== "pending") continue;
		if (job.dueAt > options.now()) {
			noteNext(job.dueAt);
			continue;
		}
		if (await isCancelled(options.dir, job.id)) continue;
		const queue = bySession.get(job.sessionId) ?? [];
		queue.push(job);
		bySession.set(job.sessionId, queue);
	}

	const queues = [...bySession.values()];
	const workers = Math.max(1, Math.min(options.concurrency ?? 4, queues.length));
	let next = 0;
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (next < queues.length) {
				const queue = queues[next++] ?? [];
				for (const job of queue) {
					let event: RunnerEvent | undefined;
					try {
						event = await fireOne(options, job);
					} catch (error) {
						// One session's failure must not end the pass: other sessions' deliveries keep running.
						const message = error instanceof Error ? error.message : String(error);
						events.push({ event: "error", id: job.id, sessionId: job.sessionId, error: message });
						noteNext(options.now() + DEFERRED_RETRY_MS);
						break; // keep this session's later jobs behind the failed one
					}
					if (event === undefined) continue;
					events.push(event);
					if (event.event === "fired" && event.nextDueAt !== undefined) noteNext(event.nextDueAt);
					if (event.event === "deferred") {
						// Retry later, not at the (past) due time: a busy session must not make --watch spin.
						noteNext(options.now() + DEFERRED_RETRY_MS);
						break; // keep this session's later jobs behind the deferred one
					}
				}
			}
		}),
	);
	return { events, nextDueAt };
}
