/**
 * The runner process of `senpi schedule run [--watch]`: its lease and heartbeat, the pass loop
 * (woken by new jobs through a `pending/` watch, by the next due time, or by the poll interval),
 * signal handling, and the JSON event lines it prints.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { isBunBinary } from "../config.ts";
import {
	ownRunnerIdentity,
	RUNNER_HEARTBEAT_INTERVAL_MS,
	removeRunnerLease,
	writeRunnerLease,
} from "../core/extensions/builtin/schedule/runner-lease.ts";
import { resolveCliMainPath } from "../modes/rpc/host-lifecycle.ts";
import { runtimeExecArgv } from "../utils/runtime-exec-argv.ts";
import {
	type DeferProbe,
	type Delivery,
	deferWhileSessionOpen,
	execHookDelivery,
	sessionResumeDelivery,
} from "./schedule-delivery.ts";
import { type RunDueResult, type RunnerEvent, runDueJobs } from "./schedule-runner.ts";

export interface RunOptions {
	readonly watch: boolean;
	readonly exec: string | undefined;
	readonly pollSeconds: number;
	readonly timeoutSeconds: number;
	readonly concurrency: number;
}

/** One line of a runner's log: a delivery event of a pass, or the runner's own lifecycle. */
export type ScheduleRunEvent =
	| RunnerEvent
	| { readonly event: "lease_error"; readonly error: string }
	| { readonly event: "watching"; readonly pid: number; readonly dir: string; readonly pollSeconds: number }
	| { readonly event: "stopped"; readonly pid: number };

interface DeliveryPlan {
	readonly deliver: Delivery;
	readonly shouldDefer: DeferProbe | undefined;
}

function resolveDelivery(options: RunOptions): DeliveryPlan {
	const timeoutMs = options.timeoutSeconds * 1000;
	if (options.exec !== undefined)
		return { deliver: execHookDelivery(options.exec, timeoutMs), shouldDefer: undefined };
	return {
		deliver: sessionResumeDelivery(
			{ command: process.execPath, args: isBunBinary ? [] : [...runtimeExecArgv(), resolveCliMainPath()] },
			timeoutMs,
		),
		shouldDefer: deferWhileSessionOpen,
	};
}

/**
 * Reports a pass; a job deferred for the same reason, or a job file invalid for the same reason, is
 * reported once per runner, not every pass.
 */
function reporter(emit: (event: ScheduleRunEvent) => void): (result: RunDueResult) => boolean {
	const deferred = new Map<string, string>();
	const invalid = new Map<string, string>();
	return (result) => {
		let ok = true;
		const stillInvalid = new Set<string>();
		for (const event of result.events) {
			if (event.event === "deferred") {
				if (deferred.get(event.id) === event.reason) continue;
				deferred.set(event.id, event.reason);
			} else if (event.event === "invalid") {
				stillInvalid.add(event.file);
				if (invalid.get(event.file) === event.error) continue;
				invalid.set(event.file, event.error);
			} else if (event.event === "fired") {
				deferred.delete(event.id);
				if (event.outcome === "failed") ok = false;
			} else if (event.event === "error") {
				ok = false;
			}
			emit(event);
		}
		for (const file of invalid.keys()) if (!stillInvalid.has(file)) invalid.delete(file);
		return ok;
	};
}

/** A pass that fails as a whole (for example an unreadable schedule directory) is reported, not thrown. */
async function guardedPass(pass: () => Promise<RunDueResult>): Promise<RunDueResult> {
	try {
		return await pass();
	} catch (error) {
		return {
			events: [{ event: "error", error: error instanceof Error ? error.message : String(error) }],
			nextDueAt: undefined,
		};
	}
}

/**
 * Runs the passes: once, or until `signal` aborts with `watch`. Answers whether every delivery of a
 * single pass succeeded; a watching runner answers true when it stops.
 */
export async function runPasses(
	dir: string,
	options: RunOptions,
	emit: (event: ScheduleRunEvent) => void,
	signal?: AbortSignal,
): Promise<boolean> {
	const plan = resolveDelivery(options);
	const owner = ownRunnerIdentity();
	const startedAt = Date.now();
	const lease = () =>
		writeRunnerLease(dir, { startedAt, watch: options.watch, exec: options.exec ?? null }, Date.now());
	const report = reporter(emit);
	const pass = () =>
		runDueJobs({
			dir,
			now: Date.now,
			deliver: plan.deliver,
			owner,
			concurrency: options.concurrency,
			deliveryTimeoutMs: options.timeoutSeconds * 1000,
			shouldDefer: plan.shouldDefer,
		});

	await lease();
	// The heartbeat keeps beating while a long delivery runs, so this runner never looks dead mid-delivery.
	let leaseFailing = false;
	const heartbeat = setInterval(() => {
		lease().then(
			() => {
				leaseFailing = false;
			},
			(error: unknown) => {
				// Reported once per failure streak: until it recovers, tools see no available runner.
				if (!leaseFailing)
					emit({ event: "lease_error", error: error instanceof Error ? error.message : String(error) });
				leaseFailing = true;
			},
		);
	}, RUNNER_HEARTBEAT_INTERVAL_MS);
	let watcher: FSWatcher | undefined;
	let stopping = false;
	let wake: (() => void) | undefined;
	const stop = () => {
		stopping = true;
		wake?.();
	};
	try {
		if (!options.watch) return report(await guardedPass(pass));

		if (signal?.aborted) stop();
		signal?.addEventListener("abort", stop);
		// A job created by another process wakes the runner at once instead of at the next poll.
		const pendingDir = join(dir, "pending");
		mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
		watcher = watch(pendingDir, () => wake?.());
		emit({ event: "watching", pid: process.pid, dir, pollSeconds: options.pollSeconds });
		while (!stopping) {
			let rescan = false;
			const woken = new Promise<void>((resolve) => {
				wake = () => {
					rescan = true;
					resolve();
				};
			});
			// A failed pass is reported and retried at the next poll; it never stops the runner.
			const result = await guardedPass(pass);
			report(result);
			if (stopping) break;
			if (rescan) continue; // something changed during the pass
			const untilDue = result.nextDueAt === undefined ? Number.POSITIVE_INFINITY : result.nextDueAt - Date.now();
			const waitMs = Math.max(0, Math.min(options.pollSeconds * 1000, untilDue));
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([woken, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
			clearTimeout(timer);
		}
		emit({ event: "stopped", pid: process.pid });
		return true;
	} finally {
		clearInterval(heartbeat);
		watcher?.close();
		signal?.removeEventListener("abort", stop);
		await removeRunnerLease(dir);
	}
}
