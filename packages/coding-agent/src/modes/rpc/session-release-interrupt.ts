/**
 * What `release_session { interrupt: true }` does to a busy session before its final check: it takes the
 * queued input out - reported back to the caller, never run here - then aborts the work and waits, bounded,
 * for it to settle. Taking the input is synchronous, so what it took is known before anything can fail.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { deliveryIdOf } from "../../core/external-admission.ts";
import { messageTicket } from "../../core/lifecycle-delivery.ts";

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

/**
 * Aborts the work, waits (bounded) for it to settle, then hands back the deliveries it left unwritten: their ids, for
 * the caller to report. Nothing is handed back while the session is still busy.
 */
export async function abortAndSettle(
	port: ReleaseSettlePort,
	sessionId: string,
	session: AgentSession,
): Promise<readonly string[]> {
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
	return session.isIdle ? handBackUnwrittenDeliveries(session) : [];
}

/**
 * A delivery admitted while a run was busy waits in the runtime's follow-up queue. When that run is aborted it stays
 * there for a person's next turn and its admission stays pending, which refused every interrupting unload forever
 * (oh-my-openagent#14169). Settled after an interrupt, such deliveries leave the queue and the ledger unwritten, so
 * their sender redelivers them to the next owner, as `takeQueuedInput` does for a release. A delivery in engine
 * custody (a ticket) is the lifecycle's own and stays.
 */
function handBackUnwrittenDeliveries(session: AgentSession): readonly string[] {
	const admittedBefore = session.externalAdmission.list().pending;
	for (const queued of session.agent.peekQueuedMessages({ all: true })) {
		if (queued.role === "custom" && deliveryIdOf(queued) !== undefined && messageTicket(queued) === undefined)
			session.agent.removeQueuedMessage(queued);
	}
	session.externalAdmission.dropQueued();
	const stillAdmitted = new Set(session.externalAdmission.list().pending);
	return admittedBefore.filter((deliveryId) => !stillAdmitted.has(deliveryId));
}
