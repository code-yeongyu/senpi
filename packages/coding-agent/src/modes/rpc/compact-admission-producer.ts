import { CompactAdmissionError } from "./compact-admission-error.ts";
import { OPEN_AFTER_QUEUED_DEADLINE_MS } from "./rpc-request-deadline.ts";

/** Join the operation or its epoch abort, releasing late results without publishing them. */
export function runAdmissionProducer<T>(
	signal: AbortSignal,
	produce: () => Promise<T>,
	release: (value: T) => Promise<void>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		void produce()
			.then(async (value) => {
				if (signal.aborted) await release(value);
				else resolve(value);
			}, reject)
			.finally(() => signal.removeEventListener("abort", abort))
			.catch(() => {
				// The caller already observed the abort; late cleanup cannot answer it again.
			});
	});
}

export type ProducerLosses = { abandoned: number; releaseFailed: number };

/** Abandoned producers and failed late releases are leak signals: counted and logged, never silent. */
export function recordProducerLoss(
	losses: ProducerLosses,
	kind: keyof ProducerLosses,
	count: number,
	cause?: unknown,
): void {
	if (count <= 0) return;
	losses[kind] += count;
	const detail = cause === undefined ? "" : `: ${cause instanceof Error ? cause.message : String(cause)}`;
	process.stderr.write(`senpi rpc admission producer ${kind} ${count}${detail}\n`);
}

/** One deadline per ending epoch, shared by all its bounded producers and duplicate teardown calls. */
export class AdmissionProducerLifetime {
	private readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	private timer: ReturnType<typeof setTimeout> | undefined;

	end(abandoned: () => void): void {
		this.timer ??= setTimeout(() => {
			abandoned();
			this.controller.abort(new CompactAdmissionError("storage_unavailable"));
		}, OPEN_AFTER_QUEUED_DEADLINE_MS);
		this.timer.unref();
	}

	close(): void {
		clearTimeout(this.timer);
	}
}
