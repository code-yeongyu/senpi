export interface RoundRobinSession {
	readonly offset: number;
	account?: string;
}

/** Process-local cursors spread new affinity keys; remembered choices keep their prompt caches local. */
class RoundRobinState {
	readonly #providers = new Map<string, { next: number; sessions: Map<string, RoundRobinSession> }>();

	session(provider: string, affinityKey?: string): RoundRobinSession {
		let state = this.#providers.get(provider);
		if (state === undefined) {
			state = { next: 0, sessions: new Map() };
			this.#providers.set(provider, state);
		}
		const held = affinityKey === undefined ? undefined : state.sessions.get(affinityKey);
		if (held !== undefined) return held;
		const session = { offset: state.next++ };
		if (affinityKey !== undefined) state.sessions.set(affinityKey, session);
		return session;
	}
}

export const roundRobinState = new RoundRobinState();
