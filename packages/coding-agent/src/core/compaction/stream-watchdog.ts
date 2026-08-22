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

/**
 * A stream that keeps trickling events never trips the idle watchdog, yet the
 * summarization it feeds is serialized on the session's agent-event queue: a
 * slow-but-alive request holds tool results at the batch barrier and keeps typed
 * input queued until the user aborts. The wall-clock budget bounds that class.
 */
export class StreamDurationBudgetError extends Error {
	readonly maxDurationMs: number;
	constructor(maxDurationMs: number) {
		super(
			`Summarization stream exceeded its ${maxDurationMs}ms wall-clock budget; treating the request as too slow to keep the session waiting`,
		);
		this.name = "StreamDurationBudgetError";
		this.maxDurationMs = maxDurationMs;
	}
}

/** Matches the agent stream idle-timeout default (`httpIdleTimeoutMs`). */
export const DEFAULT_SUMMARIZATION_IDLE_TIMEOUT_MS = 300_000;

/**
 * Total time one summarization attempt may hold the session. Large sessions
 * (200k+ tokens) on slower models take minutes, not tens of seconds; 15 minutes
 * still bounds a live-but-slow provider so the session is not stuck forever.
 * Silence is a different class and stays on the 300s idle timeout. Retries apply
 * this budget per attempt.
 */
export const DEFAULT_SUMMARIZATION_MAX_DURATION_MS = 900_000;

export interface ConsumeStreamWithIdleTimeoutOptions<T> {
	/** Silence budget per read; the timer resets on every event. */
	readonly idleTimeoutMs: number;
	/** Total wall-clock budget for the whole stream; omit to leave it unbounded. */
	readonly maxDurationMs?: number;
	/** Tear down the underlying request (abort the request-local controller). */
	readonly abort: () => void;
	readonly onEvent?: (event: T) => void;
	/** Caller cancellation; an abort here ends the wait without an idle error. */
	readonly signal?: AbortSignal;
}

const IDLE_TRIP = "idle-trip" as const;
const BUDGET_TRIP = "budget-trip" as const;
const CALLER_ABORTED = "caller-aborted" as const;

/**
 * Drain an event stream, failing with {@link StreamIdleTimeoutError} when no
 * event arrives within `idleTimeoutMs`. Caller aborts propagate as the
 * stream's own abort outcome, never masked as an idle timeout.
 */
export async function consumeStreamWithIdleTimeout<T>(
	stream: AsyncIterable<T> | PromiseLike<AsyncIterable<T>>,
	options: ConsumeStreamWithIdleTimeoutOptions<T>,
): Promise<void> {
	const { idleTimeoutMs, maxDurationMs, abort, onEvent, signal } = options;
	let iterator: AsyncIterator<T> | undefined;
	let removeAbortListener: (() => void) | undefined;
	let callerAbortPromise: Promise<typeof CALLER_ABORTED> | undefined;
	if (signal?.aborted) {
		return;
	}
	// One absolute deadline for the whole stream, not a per-read budget. Created
	// only after the already-aborted early return so no timer is ever leaked.
	let budgetPromise: Promise<typeof BUDGET_TRIP> | undefined;
	let budgetTimer: ReturnType<typeof setTimeout> | undefined;
	let budgetMs = 0;
	if (maxDurationMs !== undefined) {
		budgetMs = maxDurationMs;
		const { promise, resolve } = Promise.withResolvers<typeof BUDGET_TRIP>();
		budgetTimer = setTimeout(() => resolve(BUDGET_TRIP), budgetMs);
		budgetTimer.unref?.();
		budgetPromise = promise;
	}
	if (signal !== undefined) {
		const { promise, resolve } = Promise.withResolvers<typeof CALLER_ABORTED>();
		const onAbort = () => resolve(CALLER_ABORTED);
		signal.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		callerAbortPromise = promise;
	}
	try {
		let resolvedStream: AsyncIterable<T>;
		if (Symbol.asyncIterator in stream) {
			resolvedStream = stream;
		} else {
			const streamContenders: Array<Promise<AsyncIterable<T> | typeof BUDGET_TRIP | typeof CALLER_ABORTED>> = [
				Promise.resolve(stream),
			];
			if (callerAbortPromise) streamContenders.push(callerAbortPromise);
			if (budgetPromise) streamContenders.push(budgetPromise);
			const resolution = await Promise.race(streamContenders);
			if (resolution === BUDGET_TRIP) {
				abort();
				throw new StreamDurationBudgetError(budgetMs);
			}
			if (resolution === CALLER_ABORTED) return;
			resolvedStream = resolution;
		}
		iterator = resolvedStream[Symbol.asyncIterator]();

		while (true) {
			const { promise: idlePromise, resolve: resolveIdle } = Promise.withResolvers<typeof IDLE_TRIP>();
			const timer = setTimeout(() => resolveIdle(IDLE_TRIP), idleTimeoutMs);
			timer.unref?.();
			const contenders: Array<
				Promise<IteratorResult<T> | typeof IDLE_TRIP | typeof BUDGET_TRIP | typeof CALLER_ABORTED>
			> = [iterator.next(), idlePromise];
			if (callerAbortPromise) contenders.push(callerAbortPromise);
			if (budgetPromise) contenders.push(budgetPromise);
			let result: IteratorResult<T> | typeof IDLE_TRIP | typeof BUDGET_TRIP | typeof CALLER_ABORTED;
			try {
				result = await Promise.race(contenders);
			} finally {
				clearTimeout(timer);
			}
			if (result === IDLE_TRIP) {
				abort();
				void iterator?.return?.();
				throw new StreamIdleTimeoutError(idleTimeoutMs);
			}
			if (result === BUDGET_TRIP) {
				abort();
				void iterator?.return?.();
				throw new StreamDurationBudgetError(budgetMs);
			}
			if (result === CALLER_ABORTED) {
				void iterator?.return?.();
				return;
			}
			if (result.done) return;
			onEvent?.(result.value);
		}
	} finally {
		removeAbortListener?.();
		if (budgetTimer !== undefined) clearTimeout(budgetTimer);
	}
}
