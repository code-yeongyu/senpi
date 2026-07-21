/**
 * Idle watchdog for compaction summarization streams.
 *
 * A provider connection can stall — open but silent — for far longer than any
 * user will wait, and compaction previously had no bound at all: the session
 * sat on "Compacting…" until ESC aborted it. The agent loop's main-turn
 * reader already has this shape of protection (`StreamIdleTimeoutError` in
 * packages/agent); this brings the same guarantee to summarization requests.
 */

export class StreamIdleTimeoutError extends Error {
	readonly idleTimeoutMs: number;
	constructor(idleTimeoutMs: number) {
		super(`Summarization stream stalled: no provider events for ${idleTimeoutMs}ms; treating the request as dead`);
		this.name = "StreamIdleTimeoutError";
		this.idleTimeoutMs = idleTimeoutMs;
	}
}

/** Matches the agent stream idle-timeout default (`httpIdleTimeoutMs`). */
export const DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS = 300_000;

export interface ConsumeStreamWithIdleTimeoutOptions<T> {
	/** Silence budget per read; the timer resets on every event. */
	readonly idleTimeoutMs: number;
	/** Tear down the underlying request (abort the request-local controller). */
	readonly abort: () => void;
	readonly onEvent?: (event: T) => void;
	/** Caller cancellation; an abort here ends the wait without an idle error. */
	readonly signal?: AbortSignal;
}

const IDLE_TRIP = "idle-trip" as const;
const CALLER_ABORTED = "caller-aborted" as const;

/**
 * Drain an event stream, failing with {@link StreamIdleTimeoutError} when no
 * event arrives within `idleTimeoutMs`. Caller aborts propagate as the
 * stream's own abort outcome, never masked as an idle timeout.
 */
export async function consumeStreamWithIdleTimeout<T>(
	stream: AsyncIterable<T>,
	options: ConsumeStreamWithIdleTimeoutOptions<T>,
): Promise<void> {
	const iterator = stream[Symbol.asyncIterator]();
	const { idleTimeoutMs, abort, onEvent, signal } = options;
	let removeAbortListener: (() => void) | undefined;
	let callerAbortPromise: Promise<typeof CALLER_ABORTED> | undefined;
	if (signal !== undefined) {
		if (signal.aborted) {
			void iterator.return?.();
			return;
		}
		const { promise, resolve } = Promise.withResolvers<typeof CALLER_ABORTED>();
		const onAbort = () => resolve(CALLER_ABORTED);
		signal.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		callerAbortPromise = promise;
	}
	try {
		while (true) {
			const { promise: idlePromise, resolve: resolveIdle } = Promise.withResolvers<typeof IDLE_TRIP>();
			const timer = setTimeout(() => resolveIdle(IDLE_TRIP), idleTimeoutMs);
			timer.unref?.();
			const contenders: Array<Promise<IteratorResult<T> | typeof IDLE_TRIP | typeof CALLER_ABORTED>> = [
				iterator.next(),
				idlePromise,
			];
			if (callerAbortPromise) contenders.push(callerAbortPromise);
			let result: IteratorResult<T> | typeof IDLE_TRIP | typeof CALLER_ABORTED;
			try {
				result = await Promise.race(contenders);
			} finally {
				clearTimeout(timer);
			}
			if (result === IDLE_TRIP) {
				abort();
				void iterator.return?.();
				throw new StreamIdleTimeoutError(idleTimeoutMs);
			}
			if (result === CALLER_ABORTED) {
				void iterator.return?.();
				return;
			}
			if (result.done) return;
			onEvent?.(result.value);
		}
	} finally {
		removeAbortListener?.();
	}
}
