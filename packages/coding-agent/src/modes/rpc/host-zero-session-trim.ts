/**
 * Zero-session trim: when a host that held sessions drops to zero of them, collect once and say what
 * that returned (`host_trimmed`, footprint before and after).
 *
 * Every session's state is per session - its runtime, its extension module graph (#1948) - so once
 * the registry is empty nothing live references it, yet the process keeps the pages until a full
 * collection runs; an idle task shard otherwise sits at its peak footprint for its whole idle window.
 * At most one trim per minute; idle exit is untouched. The single full collection is the accepted
 * exception to the no-sync rule, and the record is what logs it.
 *
 * A busy shard (a parent's task DAG) may never reach zero while it runs: its footprint stayed at
 * 40-60 GB while about 30 children came and went, almost all of it freed heap pages, because a host
 * whose other sessions keep allocating never goes idle long enough to return them (senpi#3218). So a
 * drop in the session count also trims, but only once the footprint is at least
 * {@link DECLINE_TRIM_FLOOR_BYTES}: a small host never pays the collection pause. With sessions still
 * running, the pause blocks them, so each collection is timed and the next busy-host trim waits at
 * least {@link DECLINE_TRIM_PAUSE_FACTOR} times that pause, which keeps collection near 1% of a busy
 * host's loop in steady state. A drop that lands inside that wait is kept and answered when it ends.
 * The zero-session trim keeps the plain one-minute spacing: no session is left to block. The first busy-host trim has no earlier pause to wait on, and one
 * collection on a multi-GB live heap can itself pass the stall threshold (measured: 63 ms at 0.5 GB live
 * and 149 ms at 1.5 GB on one machine, 5.2 s at 3 GB live on a slower one); that costs a `host_stalled`
 * record and ~120 s of refused ensures, never a session, and beats holding tens of GB of freed pages.
 */
import { type ProcessFootprint, readOwnFootprint } from "../../core/process-footprint.ts";
import type { RpcHostTrimmedEvent } from "./rpc-host-lifecycle-types.ts";

export const ZERO_SESSION_TRIM_TICK_MS = 1_000;
export const ZERO_SESSION_TRIM_MIN_INTERVAL_MS = 60_000;
/** Below this footprint a session-count drop with sessions still open does not collect. */
export const DECLINE_TRIM_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;
/** A busy-host trim waits at least this many times the previous collection's pause. */
export const DECLINE_TRIM_PAUSE_FACTOR = 100;

const BYTES_PER_MEGABYTE = 1024 * 1024;

export interface ZeroSessionTrimmerOptions {
	readonly emit: (record: RpcHostTrimmedEvent) => void;
	/** Live sessions, including ones opening or closing. */
	readonly sessions: () => number;
	readonly now?: () => number;
	/** Monotonic milliseconds for timing a collection; a wall-clock jump must not stretch the next wait. */
	readonly monotonicNow?: () => number;
	readonly readFootprint?: () => ProcessFootprint;
	/** Runs one full collection; `false` when the runtime exposes none. */
	readonly collect?: () => boolean;
}

interface PendingTrim {
	readonly beforeBytes: number;
	readonly collected: boolean;
	readonly sessions: number;
	readonly pauseMs: number;
}

export class ZeroSessionTrimmer {
	private readonly options: ZeroSessionTrimmerOptions;
	private readonly now: () => number;
	private heldSessions = false;
	private lastSessionCount = 0;
	/**
	 * A drop not yet answered: kept across ticks until the busy interval has elapsed and the footprint
	 * was checked, so children closing inside the cooldown still get their trim once it ends. A backfill
	 * in the same second must not hide it either.
	 */
	private declined = false;
	private lastTrimAt: number | undefined;
	/** A collection that ran on the previous tick; its record waits for the allocator to return the pages. */
	private pending: PendingTrim | undefined;
	private lastPauseMs = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: ZeroSessionTrimmerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (this.timer !== undefined) return;
		// Unref'd: a trim must never be the reason the host stays alive.
		this.timer = setInterval(() => this.check(), ZERO_SESSION_TRIM_TICK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** The registry's own signal: any session that existed, however briefly, makes the next zero a transition. */
	observe(size: number): void {
		if (size > 0) this.heldSessions = true;
		if (size < this.lastSessionCount) this.declined = true;
		this.lastSessionCount = size;
	}

	check(): void {
		if (this.pending !== undefined) this.report(this.pending);
		const sessions = this.options.sessions();
		if (sessions < this.lastSessionCount) this.declined = true;
		this.lastSessionCount = sessions;
		if (sessions > 0) {
			this.heldSessions = true;
			if (!this.declined || !this.busyIntervalElapsed()) return;
			this.declined = false;
			if (this.readFootprint().bytes >= DECLINE_TRIM_FLOOR_BYTES) this.trim(sessions);
			return;
		}
		this.declined = false;
		if (!this.heldSessions) return;
		this.heldSessions = false;
		if (!this.intervalElapsed(ZERO_SESSION_TRIM_MIN_INTERVAL_MS)) return;
		this.trim(0);
	}

	private intervalElapsed(minimumMs: number): boolean {
		return this.lastTrimAt === undefined || this.now() - this.lastTrimAt >= minimumMs;
	}

	private busyIntervalElapsed(): boolean {
		return this.intervalElapsed(
			Math.max(ZERO_SESSION_TRIM_MIN_INTERVAL_MS, this.lastPauseMs * DECLINE_TRIM_PAUSE_FACTOR),
		);
	}

	private trim(sessions: number): void {
		const beforeBytes = this.readFootprint().bytes;
		const monotonicNow = this.options.monotonicNow ?? performance.now.bind(performance);
		const startedAt = monotonicNow();
		const collected = (this.options.collect ?? collectFully)();
		this.lastPauseMs = Math.round(monotonicNow() - startedAt);
		this.lastTrimAt = this.now();
		this.pending = { beforeBytes, collected, sessions, pauseMs: this.lastPauseMs };
	}

	/** One tick after the collection: freed pages are decommitted lazily, so an immediate read shows none of it. */
	private report(pending: PendingTrim): void {
		this.pending = undefined;
		const after = this.readFootprint();
		this.options.emit({
			type: "host_trimmed",
			footprintBeforeMb: Math.round(pending.beforeBytes / BYTES_PER_MEGABYTE),
			footprintAfterMb: Math.round(after.bytes / BYTES_PER_MEGABYTE),
			measure: after.measure,
			collected: pending.collected,
			sessions: pending.sessions,
			pauseMs: pending.pauseMs,
		});
	}

	private readFootprint(): ProcessFootprint {
		return (this.options.readFootprint ?? readOwnFootprint)();
	}
}

/** `Bun.gc(true)` on Bun, `gc()` on Node started with `--expose-gc`, otherwise nothing. */
export function collectFully(): boolean {
	const bun: unknown = Reflect.get(globalThis, "Bun");
	const bunGc: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
	if (typeof bunGc === "function") {
		Reflect.apply(bunGc, bun, [true]);
		return true;
	}
	const nodeGc: unknown = Reflect.get(globalThis, "gc");
	if (typeof nodeGc !== "function") return false;
	Reflect.apply(nodeGc, globalThis, []);
	return true;
}
