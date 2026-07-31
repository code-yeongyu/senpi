import type { EvalDetachedCellStatusEntry } from "../tool/detached-cell-manager.ts";
import { formatEvalCellStatus } from "./eval-status.ts";

/** Footer live-elapsed refresh cadence while at least one detached cell is running. */
export const EVAL_STATUS_TICK_INTERVAL_MS = 1000;

/** Receives the freshly formatted footer status text (undefined clears the status). */
export type EvalStatusRender = (status: string | undefined) => void;

export interface EvalStatusTickerOptions {
	readonly render: EvalStatusRender;
	/** Injectable clock for tests; defaults to Date.now. */
	readonly now?: () => number;
}

/**
 * Drives a once-per-second footer refresh while detached eval cells are running so
 * the "↗ py · … (Ns)" elapsed label advances live instead of freezing between
 * cell-set transitions. Same shape as the terminal builtin's MonitorStatusTicker:
 * the interval is unref'd, and ticks producing the already-rendered label are skipped.
 */
export class EvalStatusTicker {
	private readonly render: EvalStatusRender;
	private readonly now: () => number;
	private intervalId: NodeJS.Timeout | undefined;
	private entries: readonly EvalDetachedCellStatusEntry[] = [];
	private lastRenderedStatus: string | undefined;
	private hasRendered = false;

	constructor(options: EvalStatusTickerOptions) {
		this.render = options.render;
		this.now = options.now ?? Date.now;
	}

	get running(): boolean {
		return this.intervalId !== undefined;
	}

	/**
	 * Point the ticker at the current detached-cell set, render once immediately,
	 * and start the interval while cells are live (or stop it when none remain).
	 */
	sync(entries: readonly EvalDetachedCellStatusEntry[]): void {
		this.entries = entries;
		this.hasRendered = false;
		this.tick();
		if (entries.length === 0) {
			this.stopInterval();
			return;
		}
		if (this.intervalId !== undefined) return;
		const handle = setInterval(() => this.tick(), EVAL_STATUS_TICK_INTERVAL_MS);
		handle.unref();
		this.intervalId = handle;
	}

	/** Stop the interval and drop the retained entries. */
	stop(): void {
		this.stopInterval();
		this.entries = [];
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
		const status = formatEvalCellStatus(this.entries, this.now());
		if (this.hasRendered && status === this.lastRenderedStatus) return;
		this.hasRendered = true;
		this.lastRenderedStatus = status;
		this.render(status);
	}
}
