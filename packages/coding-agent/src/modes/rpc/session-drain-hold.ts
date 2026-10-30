import type { RouterContext } from "./session-router-context.ts";

/**
 * senpi#3114: a superseded generation parks a session only once it is idle, and nothing can reach a session on
 * it once its last client is gone - the public path belongs to the successor. A session that kept chaining
 * automatic turns (goal continuation, monitor and codemode wakes) was never idle and ran on unreachable, so a
 * parent's cancel could not stop it. Each drain pass holds the automatic turns of every open session with no
 * attachment, once per session: its running turn is its last here, and the drain parks it when that settles.
 * A session a client is still attached to keeps its turns; that client can still steer or close it.
 */
export function holdUnattendedTurns(host: RouterContext): void {
	for (const { sessionId, status, attachments } of host.registry.list()) {
		if (status !== "open" || attachments > 0 || host.drainHeldSessions.has(sessionId)) continue;
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
