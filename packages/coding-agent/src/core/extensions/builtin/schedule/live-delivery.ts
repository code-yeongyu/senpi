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
import type { Delivery } from "../../../../cli/schedule-delivery.ts";
import { DEFERRED_RETRY_MS, runDueJobs } from "../../../../cli/schedule-runner.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
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
	if (holders === 0) await writeRunnerLease(dir, { startedAt: now, watch: false, exec: null }, now);
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
	watcher: FSWatcher | undefined;
	stopped: boolean;
}

export interface LiveDeliveryDeps {
	readonly now: () => number;
	readonly timer: () => LiveTimerPort;
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
			for (const event of result.events) {
				// A job that failed inside the pass is retried later; the user still hears why it was not delivered.
				if (event.event === "error" && event.id !== undefined) {
					session.notify(`Scheduled prompt ${event.id} could not be delivered: ${event.error}`);
				}
			}
		} catch (error) {
			// The schedule directory could not be read or written: say so, and try again later rather than drop the jobs.
			session.notify(
				`Scheduled prompts could not be checked: ${error instanceof Error ? error.message : String(error)}`,
			);
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
			watcher: undefined,
			stopped: false,
		};
		try {
			const watcher = watch(pending, () => void replanFor(session));
			watcher.on("error", () => watcher.close());
			session.watcher = watcher;
		} catch {
			// Without a watch, jobs written by another process are picked up at the next armed pass.
		}
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
