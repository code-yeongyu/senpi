import { FRESH_SESSION, type TypedSession } from "./typed-lines.ts";

interface AgentSessionShells {
	readonly shells: Map<string, TypedSession>;
	/** Background sessions seen running; one that leaves this set has ended. */
	readonly live: Set<string>;
}

// Module scope, keyed by agent session: a reload re-runs the extension factory while the terminal extension keeps its
// PTY sessions alive (it parks and reclaims them), so text typed before a reload must still be judged after it.
const agentSessions = new Map<string, AgentSessionShells>();

function shellsOf(sessionKey: string): AgentSessionShells {
	let entry = agentSessions.get(sessionKey);
	if (entry === undefined) {
		entry = { shells: new Map(), live: new Set() };
		agentSessions.set(sessionKey, entry);
	}
	return entry;
}

export function typedSession(sessionKey: string, bashId: string): TypedSession {
	return agentSessions.get(sessionKey)?.shells.get(bashId) ?? FRESH_SESSION;
}

export function keepTypedSession(sessionKey: string, bashId: string, session: TypedSession): void {
	shellsOf(sessionKey).shells.set(bashId, session);
}

/** A snapshot of the running background sessions: every session seen before and missing now has ended. */
export function noteRunningShells(sessionKey: string, running: readonly string[]): void {
	const entry = shellsOf(sessionKey);
	const now = new Set(running);
	for (const id of entry.live) {
		if (now.has(id)) continue;
		entry.live.delete(id);
		entry.shells.delete(id);
	}
	for (const id of now) entry.live.add(id);
}

/** The agent session ended or was replaced, and its PTY sessions with it. */
export function forgetAgentSession(sessionKey: string): void {
	agentSessions.delete(sessionKey);
}
