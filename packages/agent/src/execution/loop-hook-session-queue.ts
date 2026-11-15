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
const MAX_TIMER_DELAY_MS = 0x7fffffff;

interface SessionQueue {
	/** Settles once the newest call that entered, and every call before it, have left. */
	last: Promise<void>;
	pending: number;
	/** Resolved, then replaced, each time one of the session's calls settles: a waiting call's bound restarts on it. */
	progress: PromiseWithResolvers<void>;
}

/**
 * One queue per session: a session's calls take their turns one at a time, in the order they entered, and calls of
 * different sessions never wait on each other. A call with no session waits on nothing. Entering costs the same
 * however long the queue is: a call chains on the newest entry, which already settles after every entry before it.
 *
 * `waitMs` bounds each call ahead, not the whole queue: a waiting call gives the calls ahead of it `waitMs` to make
 * progress, and the bound restarts only when one of them actually settles (a call ahead that merely leaves, timed out or
 * cancelled while it waited, restarts nothing). A stuck call is caught; a queue that keeps moving, however long or slow,
 * never is. A `waitMs` past `setTimeout`'s range (about 24.8 days) waits that long instead.
 */
export function createLoopHookSessionQueues(): (
	session: string | undefined,
	signal: AbortSignal,
	waitMs: number,
) => LoopHookSessionTurn {
	const queues = new Map<string, SessionQueue>();
	return (session, signal, waitMs) => {
		const left = Promise.withResolvers<void>();
		const leave = (): void => left.resolve();
		if (session === undefined) return { ready: waitForTurn(Promise.resolve(), undefined, signal, waitMs), leave };
		const queue = queues.get(session) ?? { last: Promise.resolve(), pending: 0, progress: Promise.withResolvers() };
		queues.set(session, queue);
		const ahead = queue.last;
		const settled = ahead.then(() => left.promise);
		queue.last = settled;
		queue.pending++;
		void settled.then(() => {
			queue.pending--;
			const progress = queue.progress;
			queue.progress = Promise.withResolvers();
			progress.resolve();
			if (queue.pending === 0 && queues.get(session) === queue) queues.delete(session);
		});
		return { ready: waitForTurn(ahead, queue, signal, waitMs), leave };
	};
}

async function waitForTurn(
	ahead: Promise<void>,
	queue: SessionQueue | undefined,
	signal: AbortSignal,
	waitMs: number,
): Promise<LoopHookTurnOutcome> {
	const bound = Math.min(waitMs, MAX_TIMER_DELAY_MS);
	for (;;) {
		const outcome = await waitOnce(ahead, queue?.progress.promise, signal, bound);
		if (outcome !== "progress") return outcome;
	}
}

/** One bounded wait: the turn came, the call was cancelled, the bound passed, or a call ahead settled (`progress`). */
function waitOnce(
	ahead: Promise<void>,
	progress: Promise<void> | undefined,
	signal: AbortSignal,
	waitMs: number,
): Promise<LoopHookTurnOutcome | "progress"> {
	if (signal.aborted) return Promise.resolve("cancelled");
	return new Promise((resolve) => {
		const finish = (outcome: LoopHookTurnOutcome | "progress"): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = (): void => finish("cancelled");
		const timer = setTimeout(() => finish("queue_timeout"), waitMs);
		signal.addEventListener("abort", onAbort, { once: true });
		// Registered first: when the call ahead settles, its own settle signal fires too, and the turn must win.
		void ahead.then(() => finish("turn"));
		void progress?.then(() => finish("progress"));
	});
}
