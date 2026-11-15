/**
 * Whether a loop session is still idle after one of its turns ended, as far as a hand knows (#6751 review L2, L3). A
 * hand sees a loop session only through the calls the loop forwards: after the call that ended a turn (`agent_end`),
 * the session is idle until a call that starts a turn (a real `before_agent_start`, which a local session follows with
 * `agent_start`). Every other call (an `input` the loop handles without a turn, a preview, `session_start`) leaves it
 * idle, as locally only `agent_start` drops a Stop held for background work.
 */
export interface SessionTurns {
	/** A turn of `sessionId` ended: the returned reader answers idle until a turn of that session starts. */
	ended(sessionId: string): () => boolean;
	/** A turn of `sessionId` starts: every reader of its ended turns answers busy from now on. */
	started(sessionId: string): void;
	/**
	 * The sessions held: those idle after a turn, each until its next turn starts. A session the hand only served
	 * other calls for, or whose next turn started, is not held.
	 */
	readonly size: number;
}

export function createSessionTurns(): SessionTurns {
	const idleSinceTurn = new Map<string, { idle: boolean }>();
	return {
		ended(sessionId) {
			const state = idleSinceTurn.get(sessionId) ?? { idle: true };
			idleSinceTurn.set(sessionId, state);
			return () => state.idle;
		},
		started(sessionId) {
			const state = idleSinceTurn.get(sessionId);
			if (state === undefined) return;
			state.idle = false;
			idleSinceTurn.delete(sessionId);
		},
		get size() {
			return idleSinceTurn.size;
		},
	};
}
