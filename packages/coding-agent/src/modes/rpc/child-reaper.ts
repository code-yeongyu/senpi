/**
 * Reaps the exited DIRECT children of the host process that no thread is going
 * to wait on.
 *
 * Why the host needs this at all (measured, see the matrix in the tracker): a
 * `worker_threads` Worker owns the exit watchers of every child IT spawned, and
 * `worker.terminate()` destroys those watchers with the thread - the session
 * worker quarantine (`session-worker-client.ts`) is exactly that call. Every
 * spawn API leaks the same way (node `child_process.spawn`, `Bun.spawn`,
 * `Bun.$`), under bun from source, under the compiled binary, and under Node,
 * and the zombies survive for the life of the host. Children spawned from a
 * LIVE thread are reaped by their own runtime and never reach this code.
 *
 * Why it is safe: a zombie carries no hint about which thread meant to wait on
 * it, so the only protection against STEALING a child from a live waiter is
 * time. A thread blocked in a synchronous call cannot reap its own exited child
 * until it unblocks, and stealing that child breaks the owner's contract - the
 * measurement shows `child_process` and `Bun.spawn` then reject with ECHILD and
 * `Bun.$` never settles at all. The reaper therefore waits for a pid to stay
 * waitable across two ticks at least `minWaitableMs` apart, defaulting far above
 * the longest synchronous block we measured, and it always peeks with
 * `waitid(..., WNOWAIT)` before it consumes anything.
 */
import { type ChildReaperSyscalls, loadChildReaperSyscalls } from "./child-reaper-syscalls.ts";

/** Set to `0` to turn the reaper off; anything else leaves it on. */
export const CHILD_REAPER_ENV = "SENPI_RPC_HOST_REAPER";
/** Overrides how long a child must stay waitable before it is considered abandoned. */
export const CHILD_REAPER_MIN_WAITABLE_MS_ENV = "SENPI_RPC_HOST_REAPER_MIN_WAITABLE_MS";
/** Hard floor: a pid waitable for less than this is never touched. */
export const MIN_WAITABLE_FLOOR_MS = 5_000;
/** Default window: 2.5x the longest synchronous block the matrix exercises (12 s). */
const DEFAULT_MIN_WAITABLE_MS = 30_000;
const TICK_MS = 1_000;
const WARN_INTERVAL_MS = 5 * 60_000;
/** Below this many waiting children a quiet host stays quiet. */
const WARN_AT_WAITING = 10;
const TOP_NAMES = 3;

export interface ChildReaperConfig {
	readonly enabled: boolean;
	readonly tickMs: number;
	readonly minWaitableMs: number;
}

export interface ChildReaperOptions {
	readonly syscalls: ChildReaperSyscalls;
	readonly now?: () => number;
	readonly minWaitableMs?: number;
	readonly log?: (message: string) => void;
}

export interface ChildReaper {
	/** One pass over the direct children: observe, then reap what aged out. */
	tick(): void;
	/** Children seen exited and still unclaimed, oldest observation first. */
	readonly waitingPids: readonly number[];
}

interface TrackedChild {
	name: string;
	waitableSince: number | undefined;
}

export function resolveChildReaperConfig(env: Readonly<Record<string, string | undefined>>): ChildReaperConfig {
	const override = Number(env[CHILD_REAPER_MIN_WAITABLE_MS_ENV]);
	return {
		enabled: env[CHILD_REAPER_ENV] !== "0",
		tickMs: TICK_MS,
		minWaitableMs: Number.isFinite(override) && override > 0 ? clampWindow(override) : DEFAULT_MIN_WAITABLE_MS,
	};
}

function clampWindow(milliseconds: number): number {
	return Math.max(MIN_WAITABLE_FLOOR_MS, milliseconds);
}

export function createChildReaper(options: ChildReaperOptions): ChildReaper {
	const now = options.now ?? Date.now;
	const minWaitableMs = clampWindow(options.minWaitableMs ?? DEFAULT_MIN_WAITABLE_MS);
	const tracked = new Map<number, TrackedChild>();
	let lastWarnAt: number | undefined;

	const report = (waiting: readonly string[], reaped: readonly string[]): void => {
		if (options.log === undefined || (reaped.length === 0 && waiting.length < WARN_AT_WAITING)) return;
		if (lastWarnAt !== undefined && now() - lastWarnAt < WARN_INTERVAL_MS) return;
		lastWarnAt = now();
		options.log(`child reaper: reaped=${reaped.length} waiting=${waiting.length} top=${topNames(waiting, reaped)}`);
	};

	return {
		tick() {
			const children = options.syscalls.listDirectChildren();
			const present = new Set(children);
			for (const pid of [...tracked.keys()]) if (!present.has(pid)) tracked.delete(pid);
			const reaped: string[] = [];
			for (const pid of children) {
				// A child first seen as a zombie has no name left to read: the kernel
				// keeps the exit status, not the executable.
				const child = tracked.get(pid) ?? {
					name: options.syscalls.describe(pid) || "unknown",
					waitableSince: undefined,
				};
				tracked.set(pid, child);
				// The oracle: WNOWAIT peeks at the exit status without consuming it,
				// so a live child's owner keeps every right it had before this pass.
				if (!options.syscalls.isWaitable(pid)) {
					child.waitableSince = undefined;
					continue;
				}
				if (child.waitableSince === undefined) {
					child.waitableSince = now();
					continue;
				}
				if (now() - child.waitableSince < minWaitableMs) continue;
				if (!options.syscalls.reapExited(pid)) continue;
				tracked.delete(pid);
				reaped.push(child.name);
			}
			report(waitingNames(tracked), reaped);
		},
		get waitingPids() {
			return [...tracked].filter(([, child]) => child.waitableSince !== undefined).map(([pid]) => pid);
		},
	};
}

function waitingNames(tracked: ReadonlyMap<number, TrackedChild>): readonly string[] {
	return [...tracked.values()].filter((child) => child.waitableSince !== undefined).map((child) => child.name);
}

/** The commonest command names among the children this pass accounted for. */
function topNames(waiting: readonly string[], reaped: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of [...waiting, ...reaped]) {
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts]
		.sort(([, left], [, right]) => right - left)
		.slice(0, TOP_NAMES)
		.map(([name, count]) => `${name} x${count}`)
		.join(", ");
}

/**
 * Arms the reaper on the host loop. The tick is unref'd, so it never keeps an
 * otherwise idle host alive, and the whole thing is one `setInterval` the caller
 * stops at shutdown.
 */
export async function startHostChildReaper(log: (message: string) => void): Promise<() => void> {
	const config = resolveChildReaperConfig(process.env);
	if (!config.enabled) return () => {};
	const syscalls = await loadChildReaperSyscalls();
	if (syscalls === undefined) {
		log(
			`child reaper unavailable under ${runtimeName()}: children orphaned by a terminated worker thread ` +
				`stay as zombies until this host exits`,
		);
		return () => {};
	}
	const reaper = createChildReaper({ syscalls, minWaitableMs: config.minWaitableMs, log });
	const timer = setInterval(() => reaper.tick(), config.tickMs);
	timer.unref();
	return () => clearInterval(timer);
}

let orphanSyscalls: Promise<ChildReaperSyscalls | undefined> | undefined;

/**
 * Collects the exit status of the exact exited children in `pids` right away (#1962). Only for pids whose
 * owning thread is gone, such as the children of a retired eval worker: no live thread will ever wait on them,
 * so the reaper's two-tick window protects nothing and would only leave them as zombies until it elapses.
 * A pid that is not an exited child of this process is left alone; `waitpid(-1)` is never called. Resolves to
 * the pids it collected; under Node or on Windows it collects nothing.
 */
export async function collectOrphanedChildren(pids: readonly number[]): Promise<number[]> {
	if (pids.length === 0) return [];
	orphanSyscalls ??= loadChildReaperSyscalls();
	const syscalls = await orphanSyscalls;
	if (syscalls === undefined) return [];
	return pids.filter(
		(pid) => Number.isInteger(pid) && pid > 0 && syscalls.isWaitable(pid) && syscalls.reapExited(pid),
	);
}

function runtimeName(): string {
	return typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "Node" : `Bun on ${process.platform}`;
}
