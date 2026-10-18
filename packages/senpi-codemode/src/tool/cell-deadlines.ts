import type { TimeoutPauseHandle } from "../timeouts/idle-timeout.ts";
import { RunBudget } from "../timeouts/run-budget.ts";

export type CellDeadlineKind = "hard-limit" | "run-budget";

export interface CellDeadlineExpiry {
	readonly kind: CellDeadlineKind;
	readonly error: Error;
}

export interface CellDeadlinesOptions {
	readonly cellId: string;
	readonly hardLimitSeconds: number;
	readonly runBudgetSeconds: number;
	readonly onExpire: (expiry: CellDeadlineExpiry) => void;
}

export function hardLimitError(cellId: string, hardLimitSeconds: number): Error {
	const error = new Error(`Eval cell ${cellId} was killed at the ${hardLimitSeconds}s hard limit.`);
	error.name = "TimeoutError";
	return error;
}

/**
 * The two kill deadlines every cell carries from creation to settlement, detached or not: the
 * wall-clock hard limit, which nothing pauses, and the run budget, which charges only the cell's
 * own execution time and is paused while a host bridge call is in flight. Whichever expires first
 * ends the cell; the other is disarmed with it.
 */
export class CellDeadlines implements TimeoutPauseHandle {
	readonly hardLimitSeconds: number;
	readonly runBudgetSeconds: number;
	readonly #onExpire: (expiry: CellDeadlineExpiry) => void;
	readonly #runBudget: RunBudget;
	#hardLimitTimer: ReturnType<typeof setTimeout> | undefined;
	#settled = false;

	constructor(options: CellDeadlinesOptions) {
		this.hardLimitSeconds = options.hardLimitSeconds;
		this.runBudgetSeconds = options.runBudgetSeconds;
		this.#onExpire = options.onExpire;
		const hardLimitTimer = setTimeout(
			() => this.#expire({ kind: "hard-limit", error: hardLimitError(options.cellId, options.hardLimitSeconds) }),
			options.hardLimitSeconds * 1_000,
		);
		hardLimitTimer.unref?.();
		this.#hardLimitTimer = hardLimitTimer;
		this.#runBudget = new RunBudget({
			cellId: options.cellId,
			budgetMs: options.runBudgetSeconds * 1_000,
			onExhausted: ({ error }) => this.#expire({ kind: "run-budget", error }),
		});
	}

	pause(): void {
		this.#runBudget.pause();
	}

	resume(): void {
		this.#runBudget.resume();
	}

	clear(): void {
		if (this.#settled) return;
		this.#settled = true;
		if (this.#hardLimitTimer !== undefined) clearTimeout(this.#hardLimitTimer);
		this.#hardLimitTimer = undefined;
		this.#runBudget.dispose();
	}

	#expire(expiry: CellDeadlineExpiry): void {
		if (this.#settled) return;
		this.clear();
		this.#onExpire(expiry);
	}
}
