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
 * Total time one summarization attempt may hold the session. Well above healthy
 * summarizations (tens of seconds) and below the idle budget, so a live-but-slow
 * provider fails fast enough to keep the session interactive. Retries apply this
 * budget per attempt.
 */
export const DEFAULT_SUMMARIZATION_MAX_DURATION_MS = 120_000;

type StreamEvent<Stream extends AsyncIterable<unknown>> = Stream extends AsyncIterable<infer Event> ? Event : never;

export interface ConsumeStreamWithIdleTimeoutOptions<Stream extends AsyncIterable<unknown>, Result = unknown> {
	/** Silence budget per read; the timer resets on every event. */
	readonly idleTimeoutMs: number;
	/** Total wall-clock budget for the whole stream; omit to leave it unbounded. */
	readonly maxDurationMs?: number;
	/** Tear down the underlying request (abort the request-local controller). */
	readonly abort: () => void;
	readonly onEvent?: (event: StreamEvent<Stream>) => void;
	/** Resolve the stream's final value under the same absolute duration budget. */
	readonly getResult?: (stream: Stream) => PromiseLike<Result>;
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
export function consumeStreamWithIdleTimeout<Stream extends AsyncIterable<unknown>, Result>(
	stream: Stream | PromiseLike<Stream>,
	options: ConsumeStreamWithIdleTimeoutOptions<Stream, Result> & {
		readonly getResult: (stream: Stream) => PromiseLike<Result>;
	},
): Promise<Result | undefined>;
export function consumeStreamWithIdleTimeout<Stream extends AsyncIterable<unknown>>(
	stream: Stream | PromiseLike<Stream>,
	options: ConsumeStreamWithIdleTimeoutOptions<Stream>,
): Promise<void>;
export async function consumeStreamWithIdleTimeout<Stream extends AsyncIterable<unknown>, Result>(
	stream: Stream | PromiseLike<Stream>,
	options: ConsumeStreamWithIdleTimeoutOptions<Stream, Result>,
): Promise<Result | undefined> {
	const { idleTimeoutMs, maxDurationMs, abort, onEvent, signal, getResult } = options;
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
		let resolvedStream: Stream;
		if (Symbol.asyncIterator in stream) {
			resolvedStream = stream;
		} else {
			const streamContenders: Array<Promise<Stream | typeof BUDGET_TRIP | typeof CALLER_ABORTED>> = [
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
		const iterator = resolvedStream[Symbol.asyncIterator]() as AsyncIterator<StreamEvent<Stream>>;

		while (true) {
			const { promise: idlePromise, resolve: resolveIdle } = Promise.withResolvers<typeof IDLE_TRIP>();
			const timer = setTimeout(() => resolveIdle(IDLE_TRIP), idleTimeoutMs);
			timer.unref?.();
			const contenders: Array<
				Promise<IteratorResult<StreamEvent<Stream>> | typeof IDLE_TRIP | typeof BUDGET_TRIP | typeof CALLER_ABORTED>
			> = [iterator.next(), idlePromise];
			if (callerAbortPromise) contenders.push(callerAbortPromise);
			if (budgetPromise) contenders.push(budgetPromise);
			let result:
				| IteratorResult<StreamEvent<Stream>>
				| typeof IDLE_TRIP
				| typeof BUDGET_TRIP
				| typeof CALLER_ABORTED;
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
			if (result === BUDGET_TRIP) {
				abort();
				void iterator.return?.();
				throw new StreamDurationBudgetError(budgetMs);
			}
			if (result === CALLER_ABORTED) {
				void iterator.return?.();
				if (!getResult) return undefined;
				const abortedResultContenders: Array<Promise<Result | typeof BUDGET_TRIP>> = [
					Promise.resolve(getResult(resolvedStream)),
				];
				if (budgetPromise) abortedResultContenders.push(budgetPromise);
				const abortedResult = await Promise.race(abortedResultContenders);
				if (abortedResult === BUDGET_TRIP) {
					abort();
					throw new StreamDurationBudgetError(budgetMs);
				}
				return abortedResult;
			}
			if (result.done) {
				if (!getResult) return undefined;
				const finalResultContenders: Array<Promise<Result | typeof BUDGET_TRIP>> = [
					Promise.resolve(getResult(resolvedStream)),
				];
				if (budgetPromise) finalResultContenders.push(budgetPromise);
				const finalResult = await Promise.race(finalResultContenders);
				if (finalResult === BUDGET_TRIP) {
					abort();
					throw new StreamDurationBudgetError(budgetMs);
				}
				return finalResult;
			}
			onEvent?.(result.value);
		}
	} finally {
		removeAbortListener?.();
		if (budgetTimer !== undefined) clearTimeout(budgetTimer);
	}
}
