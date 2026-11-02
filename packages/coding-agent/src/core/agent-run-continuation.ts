import type { AgentEvent } from "@earendil-works/pi-agent-core";

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
	async idleOrContinued(agentEnd: AgentEvent | undefined, waitForIdle: () => Promise<void>): Promise<boolean> {
		const base = agentEnd === undefined ? undefined : this.startsAtEnd.get(agentEnd);
		if (base === undefined) {
			await waitForIdle();
			return false;
		}
		if (this.starts > base) return true;
		let wake: (() => void) | undefined;
		const continued = new Promise<true>((resolve) => {
			wake = () => resolve(true);
			this.waiters.add(wake);
		});
		try {
			return await Promise.race([continued, waitForIdle().then(() => this.starts > base)]);
		} finally {
			if (wake !== undefined) this.waiters.delete(wake);
		}
	}
}
