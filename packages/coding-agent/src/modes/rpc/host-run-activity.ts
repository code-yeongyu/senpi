/**
 * Which sessions have an agent run in progress, from the host child's events. A run emits
 * `agent_start` on every loop iteration (a provider retry, a post-compaction continue, a follow-up)
 * but `agent_settled` once, so this tracks runs, not starts: a repeated start for a running session
 * changes nothing. A session that closes is dropped even if its settle never arrives (#2713). A settled run holds idle
 * exit until `agent_idle`, because its extension agent_settled handlers may still be running, but only for a bounded
 * hold, so a handler that never resolves cannot keep the host alive (omo#11419).
 */
export interface SessionRunActivityOptions {
	/**
	 * How long a settled session whose extension agent_settled handlers have not finished may hold idle exit. Bounded,
	 * so one handler that never resolves cannot keep the host alive forever; the supervisor uses its idle window.
	 */
	readonly settleHoldMs?: number;
	readonly now?: () => number;
	/** Told once when a settled session stops holding idle exit while its handlers are still pending. */
	readonly onSettleHoldExpired?: (sessionId: string, heldMs: number) => void;
}

export class SessionRunActivity {
	readonly #running = new Set<string>();
	/** Settled sessions not yet at agent_idle, by settle time (omo#11419). */
	readonly #settling = new Map<string, number>();
	readonly #settleHoldMs: number;
	readonly #now: () => number;
	readonly #onSettleHoldExpired: ((sessionId: string, heldMs: number) => void) | undefined;

	constructor(options: SessionRunActivityOptions = {}) {
		this.#settleHoldMs = options.settleHoldMs ?? Number.POSITIVE_INFINITY;
		this.#now = options.now ?? Date.now;
		this.#onSettleHoldExpired = options.onSettleHoldExpired;
	}

	/** Applies one host event line; true when it is a run or session event the idle decision must re-read. */
	observe(line: string): boolean {
		const event = parseHostEvent(line);
		if (event === undefined) return false;
		if (event.type === "agent_start") {
			this.#running.add(event.sessionId);
			this.#settling.delete(event.sessionId);
		} else if (event.type === "agent_settled" && event.reason !== "session_closed") {
			// The run is over, but agent_settled reaches clients before its extension handlers finish (omo#11419): the
			// session holds idle exit until agent_idle, for at most the settle hold.
			this.#running.delete(event.sessionId);
			this.#settling.set(event.sessionId, this.#now());
		} else if (event.type === "agent_settled" || event.type === "agent_idle" || event.type === "session_closed") {
			// A seal's owed settle (reason session_closed) or a closed session: nothing is left to wait for.
			this.#running.delete(event.sessionId);
			this.#settling.delete(event.sessionId);
		} else return false;
		return true;
	}

	/** Sessions with a run in progress. */
	get busySessions(): number {
		return this.#running.size;
	}

	/** Settled sessions whose agent_settled handlers may still run, within the settle hold. */
	get settlingSessions(): number {
		const now = this.#now();
		for (const [sessionId, settledAt] of this.#settling) {
			const heldMs = now - settledAt;
			if (heldMs < this.#settleHoldMs) continue;
			this.#settling.delete(sessionId);
			this.#onSettleHoldExpired?.(sessionId, heldMs);
		}
		return this.#settling.size;
	}
}

/** An idle window that ran out still waits while a settled session's handlers are within their hold (omo#11419). */
export function holdIdleExitForSettling<T extends string>(decision: T, runs: SessionRunActivity): T | "idle" {
	return decision === "exit" && runs.settlingSessions > 0 ? "idle" : decision;
}

function parseHostEvent(
	line: string,
): { readonly type: unknown; readonly sessionId: string; readonly reason: unknown } | undefined {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof event !== "object" || event === null) return undefined;
	const { type, sessionId, reason } = event as { type?: unknown; sessionId?: unknown; reason?: unknown };
	return typeof sessionId === "string" ? { type, sessionId, reason } : undefined;
}
