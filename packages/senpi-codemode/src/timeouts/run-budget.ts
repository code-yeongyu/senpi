import type { TimeoutPauseHandle } from "./idle-timeout.ts";

export interface RunBudgetEvent {
	readonly cellId: string;
	readonly budgetMs: number;
	readonly error: Error;
}

export interface RunBudgetOptions {
	readonly cellId: string;
	readonly budgetMs: number;
	readonly onExhausted: (event: RunBudgetEvent) => void;
}

export function runBudgetError(cellId: string, budgetSeconds: number): Error {
	const error = new Error(
		`Eval cell ${cellId} exhausted its ${budgetSeconds}s run budget (own execution time; host tool calls excluded) and was killed.`,
	);
	error.name = "TimeoutError";
	return error;
}

/**
 * Bounds a cell's own execution time. Unlike the idle watchdog it accumulates across host tool
 * calls instead of restarting after each one, and time spent parked on a bridge call is never
 * charged, so a long `agent()` wait survives while a runaway loop or child process does not.
 */
export class RunBudget implements TimeoutPauseHandle {
	readonly budgetMs: number;
	readonly #cellId: string;
	readonly #onExhausted: (event: RunBudgetEvent) => void;
	#chargedMs = 0;
	#runningSinceMs: number | undefined;
	#pauseDepth = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#settled = false;

	constructor(options: RunBudgetOptions) {
		this.#cellId = options.cellId;
		this.budgetMs = Math.max(1, Math.floor(options.budgetMs));
		this.#onExhausted = options.onExhausted;
		this.#start();
	}

	get consumedMs(): number {
		const running = this.#runningSinceMs === undefined ? 0 : Date.now() - this.#runningSinceMs;
		return this.#chargedMs + running;
	}

	pause(): void {
		if (this.#settled) return;
		this.#pauseDepth++;
		if (this.#pauseDepth !== 1) return;
		this.#chargedMs = this.consumedMs;
		this.#runningSinceMs = undefined;
		this.#clearTimer();
	}

	resume(): void {
		if (this.#settled || this.#pauseDepth === 0) return;
		this.#pauseDepth--;
		if (this.#pauseDepth > 0) return;
		this.#start();
	}

	dispose(): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#clearTimer();
	}

	#start(): void {
		this.#runningSinceMs = Date.now();
		this.#arm(this.budgetMs - this.#chargedMs);
	}

	#arm(delayMs: number): void {
		this.#clearTimer();
		const timer = setTimeout(() => this.#expire(), Math.max(0, delayMs));
		timer.unref?.();
		this.#timer = timer;
	}

	#clearTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#expire(): void {
		this.#timer = undefined;
		if (this.#settled || this.#pauseDepth > 0) return;
		const remainingMs = this.budgetMs - this.consumedMs;
		if (remainingMs > 0) {
			this.#arm(remainingMs);
			return;
		}
		this.#settled = true;
		this.#chargedMs = this.consumedMs;
		this.#runningSinceMs = undefined;
		this.#onExhausted({
			cellId: this.#cellId,
			budgetMs: this.budgetMs,
			error: runBudgetError(this.#cellId, this.budgetMs / 1_000),
		});
	}
}
