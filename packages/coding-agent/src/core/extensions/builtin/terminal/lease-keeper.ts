import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
	type AcquireTerminalLeaseResult,
	acquireTerminalLease,
	type LeaseHolder,
	type LeaseSelfIdentity,
	releaseTerminalLease,
} from "./manifest-lease.ts";

export const LEASE_KEEPER_INTERVAL_MS = 10_000;

export type LeaseKeeperState = "idle" | "waiting" | "owner" | "stopped";

export interface LeaseKeeperOptions {
	readonly dir: string;
	readonly encodedSessionId: string;
	readonly onTakeover: (lease: AcquireTerminalLeaseResult & { acquired: true }) => void | Promise<void>;
	/** A tick that failed (e.g. the state dir became unwritable); the keeper keeps waiting. */
	readonly onError?: (error: unknown) => void;
	readonly intervalMs?: number;
	readonly now?: () => number;
	readonly self?: LeaseSelfIdentity;
	readonly isProcessAlive?: (pid: number) => boolean;
	readonly readProcessStartMs?: (pid: number) => Promise<number | undefined>;
}

export interface LeaseKeeper {
	readonly state: LeaseKeeperState;
	onTick?: () => void;
	/** Wait on `holder`; null when it is unknown (e.g. the acquire failed), so every tick re-acquires. */
	start(holder: LeaseHolder | null): void;
	stop(): void;
	/** Resolves after the tick currently in flight (if any) has settled; tests drain fake timers with it. */
	settled(): Promise<void>;
}

function isAlive(pid: number, probe?: (pid: number) => boolean): boolean {
	try {
		if (probe) return probe(pid);
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

async function leaseFileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The WAITER side of the lease: polls the file system only (stat + kill 0, never a subprocess)
 * and hands the session over exactly once when the holder is gone. Losing the race to another
 * waiter is not an error: this keeper simply keeps waiting on the new holder.
 */
export function createLeaseKeeper(options: LeaseKeeperOptions): LeaseKeeper {
	const intervalMs = options.intervalMs ?? LEASE_KEEPER_INTERVAL_MS;
	const path = join(options.dir, `${options.encodedSessionId}.lease`);
	let state: LeaseKeeperState = "idle";
	let holder: LeaseHolder | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> = Promise.resolve();

	const arm = (): void => {
		timer = setTimeout(() => {
			timer = undefined;
			inFlight = tick().catch((error: unknown) => {
				if (state === "waiting") arm();
				options.onError?.(error);
			});
		}, intervalMs);
		timer.unref();
	};

	const tryAcquire = async (): Promise<void> => {
		const result = await acquireTerminalLease({
			dir: options.dir,
			encodedSessionId: options.encodedSessionId,
			now: options.now,
			self: options.self,
			isProcessAlive: options.isProcessAlive,
			readProcessStartMs: options.readProcessStartMs,
		});
		if (state !== "waiting") {
			// stop() landed while the acquire was in flight: hand the lease straight back, or this
			// process would hold a lease no generation of it can ever release or re-enter.
			if (result.acquired) await releaseTerminalLease(result);
			return;
		}
		if (result.acquired) {
			state = "owner";
			timer = undefined;
			await options.onTakeover(result);
			return;
		}
		holder = result.holder;
		arm();
	};

	const tick = async (): Promise<void> => {
		if (state !== "waiting") return;
		keeper.onTick?.();
		const current = holder;
		const gone = current === null || !(await leaseFileExists(path)) || !isAlive(current.pid, options.isProcessAlive);
		if (state !== "waiting") return;
		if (gone) {
			await tryAcquire();
			return;
		}
		arm();
	};

	const keeper: LeaseKeeper = {
		get state() {
			return state;
		},
		start(initialHolder) {
			if (state === "stopped" || state === "owner") return;
			holder = initialHolder;
			state = "waiting";
			if (timer === undefined) arm();
		},
		stop() {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			if (state !== "owner") state = "stopped";
		},
		settled: () => inFlight,
	};
	return keeper;
}
