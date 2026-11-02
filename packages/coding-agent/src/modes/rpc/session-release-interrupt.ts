/**
 * What `release_session { interrupt: true }` does to a busy session before its final check: it takes the
 * queued input out - reported back to the caller, never run here - then aborts the work and waits, bounded,
 * for it to settle. Taking the input is synchronous, so what it took is known before anything can fail.
 */
import type { AgentSession } from "../../core/agent-session.ts";

/** How long an `interrupt` release waits for the aborted work to settle before it re-checks. */
export const RELEASE_SETTLE_MS = 10_000;

/** What an `interrupt` release took out of the queues: delivery ids to redeliver, user text to restore. */
export interface ReleaseDropped {
	readonly deliveries: readonly string[];
	readonly user_messages: readonly string[];
}

export const NOTHING_DROPPED: ReleaseDropped = { deliveries: [], user_messages: [] };

export interface ReleaseSettlePort {
	otherRequestsSettled(sessionId: string): Promise<void>;
	/** `prompt` calls the session's binding started that have not settled, preflight included. */
	pendingPrompts(sessionId: string): readonly Promise<unknown>[];
}

/**
 * Empties both queues. Queued deliveries leave the ledger unwritten, so their sender redelivers them to
 * the next owner; the user's queued text is returned in enqueue order for the caller to restore.
 */
export function takeQueuedInput(session: AgentSession): ReleaseDropped {
	const admittedBefore = session.externalAdmission.list().pending;
	const cleared = session.clearQueue({ abortWillFollow: true });
	const stillAdmitted = new Set(session.externalAdmission.list().pending);
	return {
		deliveries: admittedBefore.filter((deliveryId) => !stillAdmitted.has(deliveryId)),
		user_messages: cleared.ordered.map((queued) => queued.text),
	};
}

export async function abortAndSettle(port: ReleaseSettlePort, sessionId: string, session: AgentSession): Promise<void> {
	session.abortBash();
	// A prompt still in preflight, or an admitted delivery, may start its run after the abort below.
	const stopStarts = session.subscribe((event) => {
		if (event.type === "agent_start") void session.abort();
	});
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<void>((resolve) => {
		deadline = setTimeout(resolve, RELEASE_SETTLE_MS);
	});
	try {
		await Promise.race([
			Promise.allSettled([
				session.abort().then(() => session.waitForIdle()),
				port.otherRequestsSettled(sessionId),
				...port.pendingPrompts(sessionId),
			]),
			expired,
		]);
	} finally {
		clearTimeout(deadline);
		stopStarts();
	}
}
