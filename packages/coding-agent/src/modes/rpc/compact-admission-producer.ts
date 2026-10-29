import { CompactAdmissionError } from "./compact-admission-error.ts";
import { OPEN_AFTER_QUEUED_DEADLINE_MS } from "./rpc-request-deadline.ts";

/** Join the operation or its epoch abort. A late settle cannot settle the caller or write an index row. */
export function runAdmissionProducer<T>(signal: AbortSignal, produce: () => Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		void produce()
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
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
	}

	close(): void {
		clearTimeout(this.timer);
	}
}
