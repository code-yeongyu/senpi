import type { MonitorSnapshotEntry } from "./monitor-registry.ts";
import { formatMonitorStatus } from "./monitor-status.ts";

/** Footer live-elapsed refresh cadence while at least one watch is active. */
export const MONITOR_STATUS_TICK_INTERVAL_MS = 1000;

/** Receives the freshly formatted footer status text (undefined clears the status). */
export type MonitorStatusRender = (status: string | undefined) => void;

export interface MonitorStatusTickerOptions {
	readonly render: MonitorStatusRender;
	/** Injectable clock for tests; defaults to Date.now. */
	readonly now?: () => number;
}

/**
 * Drives a once-per-second footer refresh while monitors are active so the
 * "◉ watching … (Ns)" elapsed label advances live instead of freezing between
 * registry transitions. Mirrors the goal builtin's GoalElapsedTicker: the
 * interval is unref'd so it never keeps the process alive, and ticks that
 * produce the already-rendered label are skipped.
 */
export class MonitorStatusTicker {
	private readonly render: MonitorStatusRender;
	private readonly now: () => number;
	private intervalId: NodeJS.Timeout | undefined;
	private snapshot: readonly MonitorSnapshotEntry[] = [];
	private lastRenderedStatus: string | undefined;
	private hasRendered = false;

	constructor(options: MonitorStatusTickerOptions) {
		this.render = options.render;
		this.now = options.now ?? Date.now;
	}

	get running(): boolean {
		return this.intervalId !== undefined;
	}

	/**
	 * Point the ticker at the current monitor snapshot, render once immediately,
	 * and start the interval when watches are live (or stop it when none remain).
	 */
	sync(snapshot: readonly MonitorSnapshotEntry[]): void {
		this.snapshot = snapshot;
		this.hasRendered = false;
		this.tick();
		if (snapshot.length === 0) {
			this.stopInterval();
			return;
		}
		if (this.intervalId !== undefined) return;
		const handle = setInterval(() => this.tick(), MONITOR_STATUS_TICK_INTERVAL_MS);
		handle.unref();
		this.intervalId = handle;
	}

	/** Stop the interval and drop the retained snapshot. */
	stop(): void {
		this.stopInterval();
		this.snapshot = [];
		this.lastRenderedStatus = undefined;
		this.hasRendered = false;
	}

	private stopInterval(): void {
		if (this.intervalId !== undefined) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}

	private tick(): void {
		const status = formatMonitorStatus(this.snapshot, this.now());
		if (this.hasRendered && status === this.lastRenderedStatus) return;
		this.hasRendered = true;
		this.lastRenderedStatus = status;
		this.render(status);
	}
}
