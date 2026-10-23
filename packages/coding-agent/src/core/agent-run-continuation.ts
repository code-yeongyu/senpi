import type { AgentEvent } from "@earendil-works/pi-agent-core";

export class AgentSettlementInterruptedError extends Error {
	readonly reason: "abort" | "timeout";

	constructor(reason: "abort" | "timeout") {
		super(`Agent settlement wait interrupted: ${reason}`);
		this.reason = reason;
		this.name = "AgentSettlementInterruptedError";
	}
}

/**
 * Whether the agent core continued a run after its `agent_end` (senpi#3650 review H1, senpi#3351).
 *
 * The core drains input queued during `agent_end` into a new loop inside the same run, while the session settles the
 * run from its own event queue. Settling waits for the agent to go idle; the core's new loop in turn waits on the
 * session (its turn-end boundary needs the message persisted on that same queue). Which side reaches the queued input
 * first depends on microtask timing, and when the core does, the two wait on each other. Observed in emission order,
 * a later `agent_start` proves the core continued, so the settle steps aside and the continuation's own `agent_end`
 * settles the run, whatever the timing.
 */
export class AgentRunContinuations {
	private starts = 0;
	private readonly startsAtEnd = new WeakMap<AgentEvent, number>();
	private readonly waiters = new Set<() => void>();

	/** Call synchronously for every agent event, in emission order. */
	observe(event: AgentEvent): void {
		if (event.type === "agent_end") {
			this.startsAtEnd.set(event, this.starts);
			return;
		}
		if (event.type !== "agent_start") return;
		this.starts += 1;
		const waiting = [...this.waiters];
		this.waiters.clear();
		for (const wake of waiting) wake();
	}

	/**
	 * Resolves true once the core starts another loop after `agentEnd`, or false once the agent is idle. Without an
	 * observed `agentEnd` it only waits for idle, as before.
	 */
	async idleOrContinued(
		agentEnd: AgentEvent | undefined,
		waitForIdle: () => Promise<void>,
		options: { signal?: AbortSignal; timeoutMs: number },
	): Promise<boolean> {
		const base = agentEnd === undefined ? undefined : this.startsAtEnd.get(agentEnd);
		if (base !== undefined && this.starts > base) return true;
		let wake: (() => void) | undefined;
		const continued = new Promise<true>((resolve) => {
			if (base === undefined) return;
			wake = () => resolve(true);
			this.waiters.add(wake);
		});
		const interrupted = Promise.withResolvers<never>();
		const abort = () => interrupted.reject(new AgentSettlementInterruptedError("abort"));
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(
			() => interrupted.reject(new AgentSettlementInterruptedError("timeout")),
			options.timeoutMs,
		);
		if (options.signal?.aborted) abort();
		try {
			return await Promise.race([
				continued,
				waitForIdle().then(() => base !== undefined && this.starts > base),
				interrupted.promise,
			]);
		} catch (error) {
			// A new loop observed before recovery owns settlement, even if interruption won the microtask race.
			if (base !== undefined && this.starts > base) return true;
			throw error;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (wake !== undefined) this.waiters.delete(wake);
		}
	}
}
