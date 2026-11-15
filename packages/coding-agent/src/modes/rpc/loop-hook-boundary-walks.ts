import type { BoundaryWalk } from "../../core/extensions/runner.ts";

// A hosted loop's stepped boundary (senpi#5898, review L8): a `turn_end` or `agent_before_settle` walk that stops after
// each hand handler that drafts. The walk's handler list is taken once, at its first step, and kept here under an id
// the reply's `resume.walk` names; every later step sends that id back and resumes by index into the same list, so a
// handler that subscribes or unsubscribes mid-walk neither shifts nor joins this walk. One walk is open per loop
// session: its first step replaces any walk the loop abandoned, and its last step (a reply without `resume`) closes it.

/** The boundary walks a hand holds open between steps, one per loop session. */
export interface BoundaryWalks {
	/** Opens a session's new walk (replacing an abandoned one) and returns its id. */
	open(sessionId: string, walk: BoundaryWalk): string;
	/** The session's open walk with this id; `undefined` when none is (it ended, or this hand process is new). */
	resume(sessionId: string, id: string): BoundaryWalk | undefined;
	close(sessionId: string): void;
}

export function createBoundaryWalks(): BoundaryWalks {
	const walks = new Map<string, { readonly id: string; readonly walk: BoundaryWalk }>();
	return {
		open(sessionId, walk) {
			const id = crypto.randomUUID();
			walks.set(sessionId, { id, walk });
			return id;
		},
		resume(sessionId, id) {
			const open = walks.get(sessionId);
			return open?.id === id ? open.walk : undefined;
		},
		close: (sessionId) => void walks.delete(sessionId),
	};
}
