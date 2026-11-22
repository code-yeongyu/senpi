import type { RouterContext } from "./session-router-context.ts";

/**
 * senpi#3114, senpi#7098: a superseded generation parks a session only once it is idle. A session that kept
 * chaining automatic turns (goal continuation, monitor and codemode wakes) was never idle, so it ran on a
 * generation nothing new can reach, and the predecessor never exited. Each drain pass holds the automatic turns
 * of every open session, once per session, attached or not: its running turn is its last here, the drain parks it
 * at that turn boundary, and the successor reopens it, where the held work resumes from the persisted session. An
 * attached client still steers or cancels the running turn and reopens the session on the successor after the park.
 */
export function holdDrainedTurns(host: RouterContext): void {
	for (const { sessionId, status } of host.registry.list()) {
		if (status !== "open" || host.drainHeldSessions.has(sessionId)) continue;
		const session = host.registry.peek(sessionId)?.runtime?.session;
		if (session === undefined) continue;
		host.drainHeldSessions.add(sessionId);
		try {
			session.holdAutomaticTurns();
		} catch (cause) {
			process.stderr.write(`senpi rpc handoff could not hold automatic turns of ${sessionId}: ${String(cause)}\n`);
		}
	}
}
