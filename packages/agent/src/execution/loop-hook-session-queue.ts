/** How one call's wait for its session's turn ended. */
export type LoopHookTurnOutcome = "turn" | "cancelled" | "queue_timeout";

export interface LoopHookSessionTurn {
	/** Settles when the call may run its hooks, was cancelled while it waited, or waited past the cap. */
	readonly ready: Promise<LoopHookTurnOutcome>;
	/**
	 * The call is done with its turn (it ran, or never will). The session's next call runs once this call and every call
	 * before it have left: a call that never ran does not let the next one overtake a call still running.
	 */
	leave(): void;
}

/**
 * One queue per session: a session's calls take their turns one at a time, in the order they entered, and calls of
 * different sessions never wait on each other. A call with no session waits on nothing.
 */
export function createLoopHookSessionQueues(): (
	session: string | undefined,
	signal: AbortSignal,
	waitMs: number,
) => LoopHookSessionTurn {
	const tails = new Map<string, Promise<void>>();
	return (session, signal, waitMs) => {
		const left = Promise.withResolvers<void>();
		const before = session === undefined ? Promise.resolve() : (tails.get(session) ?? Promise.resolve());
		if (session !== undefined) {
			const tail = before.then(() => left.promise);
			tails.set(session, tail);
			void tail.then(() => {
				if (tails.get(session) === tail) tails.delete(session);
			});
		}
		return { ready: waitForTurn(before, signal, waitMs), leave: () => left.resolve() };
	};
}

function waitForTurn(before: Promise<void>, signal: AbortSignal, waitMs: number): Promise<LoopHookTurnOutcome> {
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
		void before.then(() => finish("turn"));
	});
}
