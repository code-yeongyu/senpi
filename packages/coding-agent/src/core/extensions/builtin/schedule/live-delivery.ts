/**
 * Live delivery (senpi#4074): while a session is open in an interactive or RPC process, that process
 * fires the session's own due jobs and steers them into the running turn (or starts a turn when idle).
 * Runners keep deferring while the session is open, so the live holder is the only writer then.
 *
 * It reuses the runner's pass (`runDueJobs` scoped to this session): the same session lock, claim
 * rename, re-arm-before-delivery and settle. One timer is armed for the earliest due time; a create or
 * cancel from the tool and any change in `pending/` re-plan it, so nothing polls.
 */

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import type { Delivery } from "./delivery-contract.ts";
import { DEFERRED_RETRY_MS, runDueJobs } from "./runner.ts";
import { ownRunnerIdentity, removeRunnerLease, writeRunnerLease } from "./runner-lease.ts";
import { ensureDir, scheduleDir } from "./store.ts";

/** One-shot timer for the next pass; `fire` resolves when that pass has finished. */
export interface LiveTimerPort {
	arm(delayMs: number, fire: () => Promise<void>): void;
	cancel(): void;
}

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const NON_LIVE_MODES = new Set(["print", "json"]);

export function createNodeLiveTimer(): LiveTimerPort {
	let handle: ReturnType<typeof setTimeout> | undefined;
	return {
		arm(delayMs, fire) {
			if (handle !== undefined) clearTimeout(handle);
			handle = setTimeout(
				() => {
					handle = undefined;
					void fire();
				},
				Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS),
			);
			handle.unref?.();
		},
		cancel() {
			if (handle !== undefined) clearTimeout(handle);
			handle = undefined;
		},
	};
}

// A multi-session host runs several live sessions in one process, and the runner lease is per pid:
// the lease stays while any of them is live, so an outside runner never treats their claims as abandoned.
const leaseHolders = new Map<string, number>();

async function holdLease(dir: string, now: number): Promise<() => Promise<void>> {
	const holders = leaseHolders.get(dir) ?? 0;
	leaseHolders.set(dir, holders + 1);
	if (holders === 0) await writeRunnerLease(dir, { startedAt: now, watch: false, exec: null, holder: "session" }, now);
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		const left = (leaseHolders.get(dir) ?? 1) - 1;
		if (left > 0) {
			leaseHolders.set(dir, left);
			return;
		}
		leaseHolders.delete(dir);
		await removeRunnerLease(dir);
	};
}

interface LiveSession {
	readonly dir: string;
	readonly sessionId: string;
	readonly timer: LiveTimerPort;
	readonly release: () => Promise<void>;
	readonly notify: (message: string) => void;
	/** Jobs whose failure the user was told about: a job that keeps failing is reported once, until it stops (senpi#4130). */
	warned: Set<string>;
	/** The schedule directory could not be checked and the user was told; cleared by the next pass that can. */
	checkFailed: boolean;
	watcher: { close(): void } | undefined;
	/** A watch-triggered pass is queued and has not started: further changes ride on it (senpi#4130). */
	replanQueued: boolean;
	stopped: boolean;
}

/** Watches `pending/` for jobs other processes write; `undefined` when it cannot be watched. */
export type PendingWatchPort = (dir: string, onChange: () => void) => { close(): void } | undefined;

export function watchPendingDir(dir: string, onChange: () => void): { close(): void } | undefined {
	try {
		const watcher: FSWatcher = watch(dir, onChange);
		watcher.on("error", () => watcher.close());
		return watcher;
	} catch {
		// Without a watch, jobs written by another process are picked up at the next armed pass.
		return undefined;
	}
}

export interface LiveDeliveryDeps {
	readonly now: () => number;
	readonly timer: () => LiveTimerPort;
	readonly watch?: PendingWatchPort;
}

export interface LiveDelivery {
	/** Whether this process delivers the current session's jobs itself. */
	isLive(): boolean;
	/** Run a pass now and re-arm the timer; passes are serialized. */
	replan(): Promise<void>;
}

export function registerLiveDelivery(pi: ExtensionAPI, deps: LiveDeliveryDeps): LiveDelivery {
	let live: LiveSession | undefined;
	let tail: Promise<void> = Promise.resolve();

	const deliver: Delivery = async (event) => {
		pi.sendUserMessage(event.message, { deliverAs: "steer" });
		return { ok: true };
	};

	async function pass(session: LiveSession): Promise<void> {
		if (session.stopped) return;
		// A change seen from here on needs a new pass: this one may already have listed `pending/`.
		session.replanQueued = false;
		let nextDueAt: number | undefined;
		try {
			const result = await runDueJobs({
				dir: session.dir,
				now: deps.now,
				deliver,
				owner: ownRunnerIdentity(),
				sessionId: session.sessionId,
				concurrency: 1,
			});
			nextDueAt = result.nextDueAt;
			session.checkFailed = false;
			const failing = new Set<string>();
			for (const event of result.events) {
				// A job that failed inside the pass is retried later; the user hears why it was not delivered once, not on
				// every retry (senpi#4130). The error text can differ per attempt (a temp file name), so the job id is the key.
				if (event.event === "error" && event.id !== undefined) {
					failing.add(event.id);
					if (!session.warned.has(event.id))
						session.notify(`Scheduled prompt ${event.id} could not be delivered: ${event.error}`);
				}
			}
			session.warned = failing;
		} catch (error) {
			// The schedule directory could not be read or written: say so once, and try again later rather than drop the jobs.
			if (!session.checkFailed)
				session.notify(
					`Scheduled prompts could not be checked: ${error instanceof Error ? error.message : String(error)}`,
				);
			session.checkFailed = true;
			nextDueAt = deps.now() + DEFERRED_RETRY_MS;
		}
		if (session.stopped || nextDueAt === undefined) return;
		session.timer.arm(nextDueAt - deps.now(), () => replanFor(session));
	}

	function replanFor(session: LiveSession): Promise<void> {
		const run = tail.then(() => pass(session));
		tail = run.catch(() => undefined);
		return run;
	}

	async function stop(): Promise<void> {
		const session = live;
		live = undefined;
		if (session === undefined) return;
		session.stopped = true;
		session.timer.cancel();
		session.watcher?.close();
		// Settle a pass still in flight first: once the lease is gone an outside runner may treat its claim as abandoned.
		await tail;
		await session.release();
	}

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await stop();
		if (NON_LIVE_MODES.has(ctx.mode)) return;
		const dir = scheduleDir(ctx.agentDir);
		const pending = join(dir, "pending");
		await ensureDir(pending);
		const session: LiveSession = {
			dir,
			sessionId: ctx.sessionManager.getSessionId(),
			timer: deps.timer(),
			release: await holdLease(dir, deps.now()),
			notify: (message) => ctx.ui.notify(message, "warning"),
			warned: new Set(),
			checkFailed: false,
			watcher: undefined,
			replanQueued: false,
			stopped: false,
		};
		// Every write in `pending/`, by any session or process (and this pass's own claim rename), fires the watch:
		// coalesce them into one queued pass instead of one pass each (senpi#4130).
		session.watcher = (deps.watch ?? watchPendingDir)(pending, () => {
			if (session.replanQueued) return;
			session.replanQueued = true;
			void replanFor(session);
		});
		live = session;
		await replanFor(session);
	});

	pi.on("session_shutdown", async () => {
		await stop();
	});

	return {
		isLive: () => live !== undefined,
		replan: () => (live === undefined ? Promise.resolve() : replanFor(live)),
	};
}
