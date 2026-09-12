export interface IdleTimeoutEvent {
	readonly cellId: string;
	readonly error: Error;
}

/**
 * Upper bound on how long a single host bridge call may suspend a cell's idle watchdog.
 * Generous enough for a long build or a slow model call, short enough that a bridge call which
 * never returns cannot park the cell — and with it the agent loop — until the 1800s hard limit.
 */
export const DEFAULT_MAX_PAUSE_GRACE_MS = 600_000;

export interface IdleTimeoutOptions {
	readonly cellId: string;
	readonly timeoutMs: number;
	/** Defaults to {@link DEFAULT_MAX_PAUSE_GRACE_MS}; floored at `timeoutMs` so a pause never shortens the budget. */
	readonly maxPauseGraceMs?: number;
	readonly onTimeout: (event: IdleTimeoutEvent) => void;
}

export interface TimeoutPauseHandle {
	pause(): void;
	resume(): void;
}

export class IdleTimeout implements TimeoutPauseHandle {
	readonly #cellId: string;
	readonly #onTimeout: (event: IdleTimeoutEvent) => void;
	readonly #controller = new AbortController();
	readonly signal = this.#controller.signal;
	readonly timeoutMs: number;
	readonly maxPauseGraceMs: number;
	#deadlineMs: number;
	#pausedDeadlineMs: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#pauseDepth = 0;
	#settled = false;

	constructor(options: IdleTimeoutOptions) {
		this.#cellId = options.cellId;
		this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
		this.maxPauseGraceMs = Math.max(
			this.timeoutMs,
			Math.floor(options.maxPauseGraceMs ?? DEFAULT_MAX_PAUSE_GRACE_MS),
		);
		this.#deadlineMs = Date.now() + this.timeoutMs;
		this.#onTimeout = options.onTimeout;
		this.#arm(this.timeoutMs);
	}

	/**
	 * Suspends the idle deadline for the duration of a host bridge call, but only up to the pause grace:
	 * the cell still expires if the call never returns. Nested pauses share the outermost pause's deadline.
	 */
	pause(): void {
		if (this.#settled) return;
		this.#pauseDepth++;
		if (this.#pauseDepth !== 1) return;
		this.#pausedDeadlineMs = Date.now() + this.maxPauseGraceMs;
		this.#arm(this.maxPauseGraceMs);
	}

	resume(): void {
		if (this.#settled || this.#pauseDepth === 0) return;
		this.#pauseDepth--;
		if (this.#pauseDepth > 0) return;
		this.#pausedDeadlineMs = undefined;
		this.#deadlineMs = Date.now() + this.timeoutMs;
		this.#arm(this.timeoutMs);
	}

	dispose(): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#pausedDeadlineMs = undefined;
		this.#clearTimer();
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
		if (this.#settled) return;
		const pausedDeadlineMs = this.#pausedDeadlineMs;
		if (this.#pauseDepth > 0 && pausedDeadlineMs === undefined) return;
		const deadlineMs = pausedDeadlineMs ?? this.#deadlineMs;
		const remainingMs = deadlineMs - Date.now();
		if (remainingMs > 0) {
			this.#arm(remainingMs);
			return;
		}
		this.#settled = true;
		this.#pausedDeadlineMs = undefined;
		this.#timer = undefined;
		const error =
			pausedDeadlineMs === undefined
				? new Error(`Cell timed out after ${this.timeoutMs}ms`)
				: new Error(`Cell timed out after ${this.maxPauseGraceMs}ms waiting on a host tool call`);
		error.name = "TimeoutError";
		this.#controller.abort(error);
		this.#onTimeout({ cellId: this.#cellId, error });
	}
}
