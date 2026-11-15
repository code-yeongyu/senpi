/** How one call's wait for its session's turn ended. */
export type LoopHookTurnOutcome = "turn" | "cancelled" | "queue_timeout";

export interface LoopHookSessionTurn {
	/** Settles when the call may run its hooks, was cancelled while it waited, or a call ahead stayed unsettled too long. */
	readonly ready: Promise<LoopHookTurnOutcome>;
	/**
	 * The call is done with its turn (it ran, or never will). The session's next call runs once this call and every call
	 * before it have left: a call that never ran does not let the next one overtake a call still running.
	 */
	leave(): void;
}

/** The longest delay `setTimeout` honours (2^31 - 1 ms, about 24.8 days); a longer one fires after 1 ms. */
export const MAX_TIMER_DELAY_MS = 0x7fffffff;

/**
 * One queue per session: a session's calls take their turns one at a time, in the order they entered, and calls of
 * different sessions never wait on each other. A call with no session waits on nothing.
 *
 * `waitMs` bounds each call ahead, not the whole queue: a waiting call gives the call ahead of it `waitMs` to settle,
 * and the bound restarts each time one settles. A stuck call is caught; a queue that keeps moving, however long or slow,
 * never is. A `waitMs` past {@link MAX_TIMER_DELAY_MS} waits that long instead.
 */
export function createLoopHookSessionQueues(): (
	session: string | undefined,
	signal: AbortSignal,
	waitMs: number,
) => LoopHookSessionTurn {
	/** Each session's calls still queued or running, in order; an entry settles once it and every call before it left. */
	const queues = new Map<string, Promise<void>[]>();
	return (session, signal, waitMs) => {
		const left = Promise.withResolvers<void>();
		const leave = (): void => left.resolve();
		if (session === undefined) return { ready: waitForTurn([], signal, waitMs), leave };
		const queue = queues.get(session) ?? [];
		const ahead = [...queue];
		const settled = Promise.all(ahead).then(() => left.promise);
		queue.push(settled);
		queues.set(session, queue);
		void settled.then(() => {
			queue.splice(queue.indexOf(settled), 1);
			if (queue.length === 0 && queues.get(session) === queue) queues.delete(session);
		});
		return { ready: waitForTurn(ahead, signal, waitMs), leave };
	};
}

async function waitForTurn(
	ahead: readonly Promise<void>[],
	signal: AbortSignal,
	waitMs: number,
): Promise<LoopHookTurnOutcome> {
	if (signal.aborted) return "cancelled";
	for (const call of ahead) {
		const outcome = await waitForCall(call, signal, Math.min(waitMs, MAX_TIMER_DELAY_MS));
		if (outcome !== "turn") return outcome;
	}
	return "turn";
}

function waitForCall(call: Promise<void>, signal: AbortSignal, waitMs: number): Promise<LoopHookTurnOutcome> {
	if (signal.aborted) return Promise.resolve("cancelled");
	return new Promise((resolve) => {
		const finish = (outcome: LoopHookTurnOutcome): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = (): void => finish("cancelled");
		const timer = setTimeout(() => finish("queue_timeout"), waitMs);
		signal.addEventListener("abort", onAbort, { once: true });
		void call.then(() => finish("turn"));
	});
}
