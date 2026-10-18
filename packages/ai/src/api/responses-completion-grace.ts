/**
 * Completion-phase watchdog for OpenAI Responses streams (SSE and WebSocket,
 * every provider that goes through `processResponsesStream`).
 *
 * Once every output item has reported `response.output_item.done` and no new
 * item was added, the only event a healthy server can still send is the
 * terminal one, and it follows within milliseconds. Silence in that phase is
 * a dropped terminal event or a dead path, not the model thinking - so it gets
 * a short grace instead of the full idle budget. While any item is open the
 * idle watchdog alone applies, so long reasoning is never cut here.
 */

export const RESPONSES_COMPLETION_GRACE_MS = 60_000;

export function formatResponsesCompletionStall(graceMs: number): string {
	return `Provider stream stalled after the last output item: response.completed timed out after ${graceMs}ms`;
}

export class ResponsesCompletionStallError extends Error {
	readonly graceMs: number;

	constructor(graceMs: number) {
		super(formatResponsesCompletionStall(graceMs));
		this.name = "ResponsesCompletionStallError";
		this.graceMs = graceMs;
	}
}

interface TypedEvent {
	readonly type: string;
}

const GRACE_EXPIRED = Symbol("responses-completion-grace-expired");

/**
 * Wraps a Responses event stream so that, in the all-items-done phase, waiting
 * for the next event is bounded by `graceMs`. On expiry the wrapper throws
 * `ResponsesCompletionStallError` and releases the source without awaiting it
 * (an async generator queues `return()` behind its pending `next()`, and that
 * `next()` is exactly what is stuck).
 */
export function withResponsesCompletionGrace<T extends TypedEvent>(
	source: AsyncIterable<T>,
	graceMs: number = RESPONSES_COMPLETION_GRACE_MS,
): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator]() {
			const iterator = source[Symbol.asyncIterator]();
			let openItems = 0;
			let sawItemDone = false;
			let finished = false;

			const observe = (event: T): void => {
				if (event.type === "response.output_item.added") openItems++;
				else if (event.type === "response.output_item.done") {
					openItems = Math.max(0, openItems - 1);
					sawItemDone = true;
				}
			};

			const boundedNext = async (): Promise<IteratorResult<T>> => {
				const next = iterator.next();
				if (!sawItemDone || openItems > 0 || graceMs <= 0) return next;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const deadline = new Promise<typeof GRACE_EXPIRED>((resolve) => {
					timer = setTimeout(() => resolve(GRACE_EXPIRED), graceMs);
				});
				try {
					const winner = await Promise.race([next, deadline]);
					if (winner === GRACE_EXPIRED) {
						finished = true;
						void iterator.return?.().catch(() => undefined);
						throw new ResponsesCompletionStallError(graceMs);
					}
					return winner;
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			};

			return {
				async next(): Promise<IteratorResult<T>> {
					if (finished) return { done: true, value: undefined };
					const result = await boundedNext();
					if (result.done) finished = true;
					else observe(result.value);
					return result;
				},
				async return(value?: unknown): Promise<IteratorResult<T>> {
					finished = true;
					await iterator.return?.(value);
					return { done: true, value: undefined };
				},
				async throw(error?: unknown): Promise<IteratorResult<T>> {
					finished = true;
					if (iterator.throw) return iterator.throw(error);
					throw error;
				},
			};
		},
	};
}
