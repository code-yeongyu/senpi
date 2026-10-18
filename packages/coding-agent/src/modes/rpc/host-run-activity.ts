/**
 * Which sessions have an agent run in progress, from the host child's events. A run emits
 * `agent_start` on every loop iteration (a provider retry, a post-compaction continue, a follow-up)
 * but `agent_settled` once, so this tracks runs, not starts: a repeated start for a running session
 * changes nothing. A session that closes is dropped even if its settle never arrives (#2713).
 */
export class SessionRunActivity {
	readonly #running = new Set<string>();

	/** Applies one host event line; true when it is a run or session event the idle decision must re-read. */
	observe(line: string): boolean {
		const event = parseHostEvent(line);
		if (event === undefined) return false;
		if (event.type === "agent_start") this.#running.add(event.sessionId);
		else if (event.type === "agent_settled" || event.type === "session_closed") this.#running.delete(event.sessionId);
		else return false;
		return true;
	}

	get busySessions(): number {
		return this.#running.size;
	}
}

function parseHostEvent(line: string): { readonly type: unknown; readonly sessionId: string } | undefined {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof event !== "object" || event === null) return undefined;
	const { type, sessionId } = event as { type?: unknown; sessionId?: unknown };
	return typeof sessionId === "string" ? { type, sessionId } : undefined;
}
