/**
 * Holds turns that extensions request while `session_start` handlers are still being
 * dispatched, and starts them once every handler has returned. Handlers run one after
 * another in registration order, so a turn started from an early handler used to reach
 * the provider before a later handler had restored per-session state it depends on
 * (senpi#1972: the Claude continuity binding, forcing a full re-send). Holding the turn
 * makes that order irrelevant. Extension turn requests are fire-and-forget, so no
 * handler can be waiting on a held turn.
 */
export class SessionStartTurnGate {
	private held: Array<() => void> | undefined;
	private readonly onStartError: (error: unknown) => void;

	constructor(onStartError: (error: unknown) => void) {
		this.onStartError = onStartError;
	}

	admit(start: () => void): void {
		if (this.held) this.held.push(start);
		else start();
	}

	async dispatch<T>(run: () => Promise<T>): Promise<T> {
		if (this.held) return run();
		const held: Array<() => void> = [];
		this.held = held;
		try {
			return await run();
		} finally {
			this.held = undefined;
			for (const start of held) {
				try {
					start();
				} catch (error) {
					this.onStartError(error);
				}
			}
		}
	}
}
