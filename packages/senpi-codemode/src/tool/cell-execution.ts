import { IdleTimeout, type IdleTimeoutOptions, type TimeoutPauseHandle } from "../timeouts/idle-timeout.ts";
import type { EvalKernel } from "./types.ts";

const INTERRUPT_DELIVERY_GRACE_MS = 100;

export interface EvalTimeoutFactory {
	create(options: IdleTimeoutOptions): TimeoutPauseHandle & { dispose(): void };
}

export const defaultTimeoutFactory: EvalTimeoutFactory = {
	create(options): IdleTimeout {
		return new IdleTimeout(options);
	},
};

export interface CellExecutionOptions {
	readonly callerSignal: AbortSignal;
	readonly cellId: string;
	readonly timeoutMs: number;
	readonly timeoutFactory: EvalTimeoutFactory;
	readonly onTimeout: (error: Error) => void;
	readonly onAbort: (error: Error) => void;
}

export class CellExecution {
	readonly #callerSignal: AbortSignal;
	readonly #onAbort: (error: Error) => void;
	readonly #abortPromise: Promise<never>;
	readonly #detachedPromise: Promise<void>;
	readonly #watchdog: TimeoutPauseHandle & { dispose(): void };
	#rejectAbort: ((reason?: unknown) => void) | undefined;
	#resolveDetached: (() => void) | undefined;
	#kernel: EvalKernel | undefined;
	#interruptDeadline: ReturnType<typeof setTimeout> | undefined;
	#active = true;

	constructor(options: CellExecutionOptions) {
		this.#callerSignal = options.callerSignal;
		this.#onAbort = options.onAbort;
		this.#abortPromise = new Promise<never>((_resolve, reject) => {
			this.#rejectAbort = reject;
		});
		this.#detachedPromise = new Promise<void>((resolve) => {
			this.#resolveDetached = resolve;
		});
		this.#watchdog = options.timeoutFactory.create({
			cellId: options.cellId,
			timeoutMs: options.timeoutMs,
			onTimeout: ({ error }) => options.onTimeout(error),
		});
		this.#callerSignal.addEventListener("abort", this.#handleCallerAbort, {
			once: true,
		});
	}

	get detached(): Promise<void> {
		return this.#detachedPromise;
	}

	pause(): void {
		this.#watchdog.pause();
	}

	resume(): void {
		this.#watchdog.resume();
	}

	setKernel(kernel: EvalKernel): void {
		this.#kernel = kernel;
	}

	detach(): void {
		if (!this.#active) return;
		this.#watchdog.dispose();
		this.#resolveDetached?.();
		this.#resolveDetached = undefined;
	}

	cancel(reason: unknown): void {
		this.#abort(reason);
	}

	finish(): void {
		this.#active = false;
		this.#cleanup();
	}

	async wait<Result>(operation: Promise<Result>): Promise<Result> {
		const guarded = operation.then(
			(value): Result | Promise<never> => (this.#active ? value : this.#abortPromise),
			(reason: unknown): Promise<never> => (this.#active ? Promise.reject(reason) : this.#abortPromise),
		);
		return await Promise.race([guarded, this.#abortPromise]);
	}

	readonly #handleCallerAbort = (): void => {
		this.#abort(this.#callerSignal.reason);
	};

	interruptStateRetained: Promise<boolean> | undefined;

	#abort(reason: unknown): void {
		if (!this.#active) return;
		this.#active = false;
		this.#cleanup();
		const error = abortError(reason);
		this.#onAbort(error);
		const kernel = this.#kernel;
		if (kernel === undefined) {
			this.#settleAbort(error);
			return;
		}
		this.#interruptDeadline = setTimeout(() => this.#settleAbort(error), INTERRUPT_DELIVERY_GRACE_MS);
		void Promise.resolve()
			.then(async () => {
				const handle = await kernel.interrupt(error.message);
				this.interruptStateRetained = handle?.stateRetained;
			})
			.then(
				() => this.#settleAbort(error),
				(interruptError: unknown) => this.#settleAbort(interruptError),
			);
	}

	#settleAbort(reason: unknown): void {
		const reject = this.#rejectAbort;
		if (reject === undefined) return;
		this.#rejectAbort = undefined;
		if (this.#interruptDeadline !== undefined) clearTimeout(this.#interruptDeadline);
		reject(reason);
	}

	#cleanup(): void {
		this.#callerSignal.removeEventListener("abort", this.#handleCallerAbort);
		this.#watchdog.dispose();
		if (this.#interruptDeadline !== undefined) clearTimeout(this.#interruptDeadline);
		this.#interruptDeadline = undefined;
	}
}

export function abortError(reason: unknown): Error {
	if (reason instanceof Error && reason.name !== "AbortError") return reason;
	const error = new Error(typeof reason === "string" ? reason : "Eval interrupted", { cause: reason });
	error.name = "AbortError";
	return error;
}
