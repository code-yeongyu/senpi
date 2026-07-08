export interface IdleTimeoutEvent {
	readonly cellId: string;
	readonly error: Error;
}

export interface IdleTimeoutOptions {
	readonly cellId: string;
	readonly timeoutMs: number;
	readonly onTimeout: (event: IdleTimeoutEvent) => void;
}

export interface TimeoutPauseHandle {
	pause(): void;
	resume(): void;
}

export class IdleTimeout implements TimeoutPauseHandle {
	readonly #cellId: string;
	readonly #timeoutMs: number;
	readonly #onTimeout: (event: IdleTimeoutEvent) => void;
	readonly #controller = new AbortController();
	#remainingMs: number;
	#deadlineMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#pauseDepth = 0;
	#settled = false;

	constructor(options: IdleTimeoutOptions) {
		this.#cellId = options.cellId;
		this.#timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
		this.#remainingMs = this.#timeoutMs;
		this.#deadlineMs = Date.now() + this.#remainingMs;
		this.#onTimeout = options.onTimeout;
		this.#arm(this.#remainingMs);
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get timeoutMs(): number {
		return this.#timeoutMs;
	}

	pause(): void {
		if (this.#settled) return;
		this.#pauseDepth++;
		if (this.#pauseDepth !== 1) return;
		this.#remainingMs = Math.max(0, this.#deadlineMs - Date.now());
		this.#clearTimer();
	}

	resume(): void {
		if (this.#settled || this.#pauseDepth === 0) return;
		this.#pauseDepth--;
		if (this.#pauseDepth > 0) return;
		this.#deadlineMs = Date.now() + this.#remainingMs;
		this.#arm(this.#remainingMs);
	}

	dispose(): void {
		if (this.#settled) return;
		this.#settled = true;
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
		if (this.#settled || this.#pauseDepth > 0) return;
		const remainingMs = this.#deadlineMs - Date.now();
		if (remainingMs > 0) {
			this.#remainingMs = remainingMs;
			this.#arm(remainingMs);
			return;
		}
		this.#settled = true;
		this.#timer = undefined;
		const error = new Error(`Cell timed out after ${this.#timeoutMs}ms`);
		error.name = "TimeoutError";
		this.#controller.abort(error);
		this.#onTimeout({ cellId: this.#cellId, error });
	}
}
