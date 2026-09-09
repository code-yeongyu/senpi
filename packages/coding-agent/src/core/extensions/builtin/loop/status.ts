import type { CronEntry, LoopState } from "./types.ts";

export const LOOP_STATUS_KEY = "loop";
export const LOOP_STATUS_TICK_INTERVAL_MS = 1000;

export type LoopStatusRender = (key: string, text: string | undefined) => void;

export interface LoopStatusTickerOptions {
	readonly render: LoopStatusRender;
	readonly now?: () => number;
}

function isArmed(entry: CronEntry): boolean {
	return entry.phase !== "ended";
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) {
		const seconds = totalSeconds % 60;
		return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const mins = minutes % 60;
		return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const hrs = hours % 24;
	return hrs > 0 ? `${days}d${hrs}h` : `${days}d`;
}

function nextDueAt(entry: CronEntry): number | undefined {
	if (entry.phase === "suspended" || entry.phase === "ended") return undefined;
	if (entry.kind === "fixed") {
		return entry.nextFireAt;
	}
	return entry.pendingWakeup?.dueAt;
}

export function formatLoopStatus(state: LoopState, nowMs: number): string | undefined {
	const armed = Object.values(state.entries).filter(isArmed);
	if (armed.length === 0) {
		return undefined;
	}

	const paused = armed.some((entry) => entry.phase === "suspended");
	if (paused) {
		return "Loop paused - /loop resume or /loop stop";
	}

	let nearest: { entry: CronEntry; dueAt: number } | undefined;
	for (const entry of armed) {
		if (entry.phase === "suspended") continue;
		const dueAt = nextDueAt(entry);
		if (dueAt === undefined) continue;
		if (nearest === undefined || dueAt < nearest.dueAt) {
			nearest = { entry, dueAt };
		}
	}

	if (nearest === undefined) {
		return "Loop active - /loop stop";
	}

	const remainingMs = Math.max(0, nearest.dueAt - nowMs);
	const mode = nearest.entry.kind === "fixed" ? "fixed" : "dynamic";
	return `Loop (${mode}): next in ${formatDuration(remainingMs)} - /loop stop`;
}

export function formatNoopFold(noopStreak: number): string {
	if (noopStreak < 2) {
		return "";
	}
	return `↻ ${noopStreak} loop ticks with no actionable change`;
}

export class LoopStatusTicker {
	private readonly render: LoopStatusRender;
	private readonly now: () => number;
	private timeoutId: NodeJS.Timeout | undefined;
	private state: LoopState | undefined;
	private lastRendered: string | undefined;

	constructor(options: LoopStatusTickerOptions) {
		this.render = options.render;
		this.now = options.now ?? Date.now;
	}

	get running(): boolean {
		return this.timeoutId !== undefined;
	}

	sync(state: LoopState): void {
		this.state = state;
		this.lastRendered = undefined;
		this.tick();
		this.scheduleNext();
	}

	dispose(): void {
		if (this.timeoutId !== undefined) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
		this.state = undefined;
		this.lastRendered = undefined;
		this.render(LOOP_STATUS_KEY, undefined);
	}

	private scheduleNext(): void {
		if (this.timeoutId !== undefined) {
			clearTimeout(this.timeoutId);
		}
		const handle = setTimeout(() => {
			this.timeoutId = undefined;
			this.tick();
			if (this.state !== undefined) {
				this.scheduleNext();
			}
		}, LOOP_STATUS_TICK_INTERVAL_MS);
		handle.unref();
		this.timeoutId = handle;
	}

	private tick(): void {
		if (this.state === undefined) return;
		const text = formatLoopStatus(this.state, this.now());
		if (text === this.lastRendered) return;
		this.lastRendered = text;
		this.render(LOOP_STATUS_KEY, text);
	}
}
