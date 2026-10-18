/**
 * The turns each session's own records have opened (`agent_start`) and not yet settled (`agent_settled`),
 * counted exactly as the supervisor's lifecycle observer counts them.
 *
 * A session sealed mid-turn - closed, parked or released - never gets to publish the `agent_settled` of
 * the turn its teardown aborts: every record after the seal is dropped. The observer's count for it then
 * stays above zero for good and the host never idle-exits (worker sessions too: their `session_closed`
 * goes to attached connections only, I4, so the observer never learns the session is gone). The writer
 * asks this ledger, before it seals, how many settles the session still owes, and publishes them.
 */
export class SessionOpenTurns {
	private readonly open = new Map<string, number>();

	note(sessionId: string, type: unknown): void {
		if (type === "agent_start") this.open.set(sessionId, (this.open.get(sessionId) ?? 0) + 1);
		else if (type === "agent_settled") {
			const left = (this.open.get(sessionId) ?? 0) - 1;
			if (left > 0) this.open.set(sessionId, left);
			else this.open.delete(sessionId);
		}
	}

	/** The settles a seal is about to strand; the session's count is forgotten either way. */
	take(sessionId: string): number {
		const owed = this.open.get(sessionId) ?? 0;
		this.open.delete(sessionId);
		return owed;
	}
}
