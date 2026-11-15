/**
 * Whether a loop session is still idle after one of its turns ended, as far as a hand knows (#6751 review L2; #6770
 * review M1, L1, L2). A hand sees a loop session only through the calls the loop forwards. The call that ends a turn
 * (`agent_end`) marks the session idle when it starts, so a turn seen running while that call still runs wins. Any
 * later forwarded event that proves a turn is running ends that idleness; the others (an `input` the loop handles
 * without a turn, a preview, `session_start`) leave it, as locally only a turn's start drops a Stop held for
 * background work. A session is kept only while something can still read it: its turn-ending call, while it runs, and
 * work that outlived that call and holds it (a held Stop), until it settles.
 */
export interface SessionTurns {
	/** A call that ends a turn of `sessionId` starts. */
	ending(sessionId: string): TurnEnd;
	/** A forwarded event proves a turn of `sessionId` is running: every turn end of it answers busy from now on. */
	running(sessionId: string): void;
	/** The sessions kept: each is read by a turn-ending call still running, or held by work that outlived one. */
	readonly size: number;
}

/** One turn-ending call's view of its session. */
export interface TurnEnd {
	/** Whether the session is still idle after this turn: no turn of it was seen running since this call started. */
	idle(): boolean;
	/** Keeps the session for work that outlives the call; the returned release (idempotent) ends that hold. */
	hold(): () => void;
	/** The call returned: with no hold left, the session is forgotten. */
	callEnded(): void;
}

export function createSessionTurns(): SessionTurns {
	const sessions = new Map<string, { idle: boolean; readers: number }>();
	return {
		ending(sessionId) {
			const state = sessions.get(sessionId) ?? { idle: true, readers: 0 };
			sessions.set(sessionId, state);
			const release = () => {
				state.readers--;
				if (state.readers === 0 && sessions.get(sessionId) === state) sessions.delete(sessionId);
			};
			state.readers++;
			return {
				idle: () => state.idle,
				hold: () => {
					state.readers++;
					let held = true;
					return () => {
						if (!held) return;
						held = false;
						release();
					};
				},
				callEnded: release,
			};
		},
		running(sessionId) {
			const state = sessions.get(sessionId);
			if (state === undefined) return;
			// Its readers keep this state object, so they see the turn; the session itself is no longer idle after a turn.
			state.idle = false;
			sessions.delete(sessionId);
		},
		get size() {
			return sessions.size;
		},
	};
}
