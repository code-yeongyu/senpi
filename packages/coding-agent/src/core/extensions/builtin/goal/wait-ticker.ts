import type { ExtensionContext } from "../../types.ts";
import type { ResumptionChannelCounts } from "./monitor-continuation-types.ts";
import { isStaleExtensionContextError } from "./stale-context.ts";
import { formatGoalWaitLabel, type GoalWaitKind, type GoalWaitLabelInput } from "./wait-progress.ts";

/** Footer countdown refresh cadence while a Goal continuation is delayed. */
export const GOAL_WAIT_TICK_INTERVAL_MS = 1000;
export const GOAL_WAIT_STATUS_KEY = "goal-wait";

/** Receives the freshly formatted footer status text (undefined clears the status). */
export type GoalWaitRender = (ctx: ExtensionContext, status: string | undefined) => void;

export interface GoalWaitTickerOptions {
	readonly render: GoalWaitRender;
	/** Injectable clock for tests; defaults to Date.now. */
	readonly now?: () => number;
}

/**
 * Drives a once-per-second footer countdown while a Goal continuation timer is
 * armed. Mirrors the existing GoalElapsedTicker and MonitorStatusTicker: the
 * interval is unref'd and unchanged visible labels are not rendered again.
 */
export class GoalWaitTicker {
	private readonly render: GoalWaitRender;
	private readonly now: () => number;
	private intervalId: NodeJS.Timeout | undefined;
	private ctx: ExtensionContext | undefined;
	private kind: GoalWaitKind | undefined;
	private dueAtMs = 0;
	private totalMs = 0;
	private channelCounts: ResumptionChannelCounts = {};
	private lastRenderedStatus: string | undefined;

	constructor(options: GoalWaitTickerOptions) {
		this.render = options.render;
		this.now = options.now ?? Date.now;
	}

	get running(): boolean {
		return this.intervalId !== undefined;
	}

	/** Render the current wait immediately and keep it live until stopped. */
	sync(ctx: ExtensionContext, input: GoalWaitLabelInput): void {
		this.ctx = ctx;
		this.kind = input.kind;
		this.dueAtMs = this.now() + Math.max(0, input.remainingMs);
		this.totalMs = input.totalMs;
		this.channelCounts = { ...input.channelCounts };
		this.lastRenderedStatus = undefined;
		this.tick();
		if (this.intervalId !== undefined) return;
		const handle = setInterval(() => this.tick(), GOAL_WAIT_TICK_INTERVAL_MS);
		handle.unref();
		this.intervalId = handle;
	}

	/** Refresh channel wording without changing the countdown deadline. */
	setChannelCounts(channelCounts: ResumptionChannelCounts): void {
		if (this.ctx === undefined || this.kind !== "monitor") return;
		this.channelCounts = { ...channelCounts };
		this.tick();
	}

	/** Stop ticking, clear the footer segment, and drop the retained context. */
	stop(): void {
		if (this.intervalId !== undefined) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
		const ctx = this.ctx;
		this.ctx = undefined;
		this.kind = undefined;
		this.lastRenderedStatus = undefined;
		if (ctx !== undefined) {
			try {
				this.render(ctx, undefined);
			} catch (error) {
				// A stale ctx cannot clear its own footer status; dropping it is enough.
				if (!isStaleExtensionContextError(error)) throw error;
			}
		}
	}

	/**
	 * Drop the interval and retained ctx without a final render. Used when a tick
	 * discovers the ctx was retired by a session replacement or reload: every
	 * render against it throws from now on, and a ticker that keeps ticking dead
	 * renders freezes the footer forever without crashing. The next sync() with a
	 * live ctx re-arms everything.
	 */
	private retire(): void {
		if (this.intervalId !== undefined) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
		this.ctx = undefined;
		this.kind = undefined;
		this.lastRenderedStatus = undefined;
	}

	private tick(): void {
		if (this.ctx === undefined || this.kind === undefined) return;
		try {
			// The countdown is a parked-state display: while a turn runs the goal is
			// pursued, not waited on, so the segment clears. The armed timer (and its
			// cache-TTL deadline) is untouched, so the next idle tick re-renders it.
			const status = this.ctx.isIdle()
				? formatGoalWaitLabel({
						kind: this.kind,
						remainingMs: Math.max(0, this.dueAtMs - this.now()),
						totalMs: this.totalMs,
						channelCounts: this.channelCounts,
					})
				: undefined;
			if (status === this.lastRenderedStatus) return;
			this.lastRenderedStatus = status;
			this.render(this.ctx, status);
		} catch (error) {
			if (isStaleExtensionContextError(error)) {
				this.retire();
				return;
			}
			throw error;
		}
	}
}
