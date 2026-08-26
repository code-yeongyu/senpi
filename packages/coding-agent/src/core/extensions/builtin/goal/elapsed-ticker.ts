import type { ExtensionContext } from "../../types.ts";
import { formatGoalElapsedSeconds } from "./format.ts";
import { isStaleExtensionContextError } from "./stale-context.ts";
import type { Goal } from "./types.ts";

/** Footer live-elapsed refresh cadence while a goal is actively pursued. */
export const GOAL_ELAPSED_TICK_INTERVAL_MS = 1000;

/** Renders the goal footer segment for the current live elapsed second count. */
export type GoalElapsedRender = (ctx: ExtensionContext, goal: Goal, liveElapsedSeconds: number) => void;

export interface GoalElapsedTickerOptions {
	readonly render: GoalElapsedRender;
	/** Injectable clock for tests; defaults to Date.now. */
	readonly now?: () => number;
}

/**
 * Live elapsed seconds for an actively pursued goal: the committed
 * `timeUsedSeconds` plus whole seconds since the current measurement window
 * opened. Mirrors the rounding in `accountCurrentAgentTurn` so the footer never
 * disagrees with what the next turn commits.
 */
export function goalLiveElapsedSeconds(goal: Goal, measuredFromMilliseconds: number, nowMilliseconds: number): number {
	const elapsedSeconds = Math.max(0, Math.round((nowMilliseconds - measuredFromMilliseconds) / 1000));
	return goal.timeUsedSeconds + elapsedSeconds;
}

/**
 * Drives a once-per-second footer refresh while a goal is active so the
 * "Pursuing goal (…)" elapsed time advances live instead of freezing between
 * usage-accounting checkpoints. The interval is unref'd so it never keeps the
 * process alive.
 */
export class GoalElapsedTicker {
	private readonly render: GoalElapsedRender;
	private readonly now: () => number;
	private intervalId: NodeJS.Timeout | undefined;
	private ctx: ExtensionContext | undefined;
	private goal: Goal | undefined;
	private measuredFromMilliseconds = 0;
	private lastRenderedElapsedLabel: string | undefined;

	constructor(options: GoalElapsedTickerOptions) {
		this.render = options.render;
		this.now = options.now ?? Date.now;
	}

	get running(): boolean {
		return this.intervalId !== undefined;
	}

	/**
	 * Point the ticker at the current goal and measurement window, render once
	 * immediately, and start the interval if it is not already running.
	 */
	sync(ctx: ExtensionContext, goal: Goal, measuredFromMilliseconds: number): void {
		this.ctx = ctx;
		this.goal = goal;
		this.measuredFromMilliseconds = measuredFromMilliseconds;
		this.lastRenderedElapsedLabel = undefined;
		this.tick();
		if (this.intervalId !== undefined) return;
		const handle = setInterval(() => this.tick(), GOAL_ELAPSED_TICK_INTERVAL_MS);
		handle.unref();
		this.intervalId = handle;
	}

	/** Stop the interval and drop the retained context/goal snapshot. */
	stop(): void {
		if (this.intervalId !== undefined) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
		this.ctx = undefined;
		this.goal = undefined;
		this.lastRenderedElapsedLabel = undefined;
	}

	private tick(): void {
		if (this.ctx === undefined || this.goal === undefined) return;
		const liveElapsedSeconds = goalLiveElapsedSeconds(this.goal, this.measuredFromMilliseconds, this.now());
		const elapsedLabel = formatGoalElapsedSeconds(liveElapsedSeconds);
		if (elapsedLabel === this.lastRenderedElapsedLabel) return;
		this.lastRenderedElapsedLabel = elapsedLabel;
		try {
			this.render(this.ctx, this.goal, liveElapsedSeconds);
		} catch (error) {
			// A retired ctx (session replacement/reload) throws on every render from
			// now on; retire instead of spinning dead forever. This stop() renders
			// nothing, so it is safe against the same stale ctx. The next sync() with
			// a live ctx re-arms the ticker.
			if (isStaleExtensionContextError(error)) {
				this.stop();
				return;
			}
			throw error;
		}
	}
}
