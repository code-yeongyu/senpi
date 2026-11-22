/**
 * A file watch's registration window: every step races the registration deadline, so a wedged mount
 * fails the registration instead of freezing the loop, and a late result is cleaned up (a handle opened
 * after the deadline is closed). Finishing a pending registration either hands its capacity slot to
 * the new watch or releases it.
 */
export interface PendingFileRegistration {
	release: (() => void) | undefined;
	readonly abort: AbortController;
	readonly deadline: ReturnType<typeof setTimeout>;
	settled: boolean;
}

export class RegistrationGuard {
	readonly #pending = new Set<PendingFileRegistration>();

	open(release: (() => void) | undefined, timeoutMs: number): PendingFileRegistration {
		const pending: PendingFileRegistration = {
			release,
			abort: new AbortController(),
			deadline: setTimeout(() => pending.abort.abort(), timeoutMs),
			settled: false,
		};
		this.#pending.add(pending);
		return pending;
	}

	finishAll(): void {
		for (const pending of [...this.#pending]) this.finish(pending);
	}

	finish(pending: PendingFileRegistration, transfer = false): void {
		if (pending.settled) return;
		pending.settled = true;
		clearTimeout(pending.deadline);
		this.#pending.delete(pending);
		if (transfer) pending.release = undefined;
		else {
			pending.abort.abort();
			pending.release?.();
		}
	}

	async await<T>(
		pending: PendingFileRegistration,
		operation: Promise<T>,
		lateCleanup?: (value: T) => Promise<void>,
	): Promise<T> {
		if (pending.abort.signal.aborted) {
			void operation.then(
				(value) => lateCleanup?.(value),
				() => undefined,
			);
			throw new Error("Cannot create file monitor: registration timed out or was disposed.");
		}
		let aborted = false;
		const abort = new Promise<never>((_, reject) =>
			pending.abort.signal.addEventListener(
				"abort",
				() => {
					aborted = true;
					reject(new Error("Cannot create file monitor: registration timed out or was disposed."));
				},
				{ once: true },
			),
		);
		const guarded = operation.then(
			(value) => {
				if (aborted) void lateCleanup?.(value);
				return value;
			},
			(error) => {
				if (aborted) return undefined as T;
				throw error;
			},
		);
		return Promise.race([guarded, abort]);
	}
}
