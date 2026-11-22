import type { BoundaryWalk } from "../../core/extensions/runner.ts";

// A hosted loop's stepped boundary (senpi#5898, review L8): a `turn_end` or `agent_before_settle` walk that stops after
// each hand handler that drafts. The walk's handler list is taken once, at its first step, and kept here under an id
// the reply's `resume.walk` names; every later step sends that id back and resumes by index into the same list, so a
// handler that subscribes or unsubscribes mid-walk neither shifts nor joins this walk. The walk also holds the resume
// point its last step named, and a later step must send exactly that `from` (#6787 review L1): a repeated or skipped
// step would rerun or skip a handler, and a point past the list would end the walk silently. One walk is open per loop
// session: its first step replaces any walk the loop abandoned, and its last step (a reply without `resume`) closes it.

/** The boundary walks a hand holds open between steps, one per loop session. */
export interface BoundaryWalks {
	/** Opens a session's new walk (replacing an abandoned one) and returns its id. */
	open(sessionId: string, walk: BoundaryWalk): string;
	/**
	 * The session's open walk with this id, resumed at `from`. Throws when none is open (it ended, or this hand process
	 * is new: the loop starts the boundary over) or when `from` is not the point the walk's last step named.
	 */
	resume(sessionId: string, id: string, from: number): BoundaryWalk;
	/** Records the point the walk's step just named (`resume.next`), the only one its next step may send. */
	advance(sessionId: string, next: number): void;
	close(sessionId: string): void;
}

export function createBoundaryWalks(): BoundaryWalks {
	const walks = new Map<string, { readonly id: string; readonly walk: BoundaryWalk; next: number }>();
	return {
		open(sessionId, walk) {
			const id = crypto.randomUUID();
			walks.set(sessionId, { id, walk, next: 0 });
			return id;
		},
		resume(sessionId, id, from) {
			const open = walks.get(sessionId);
			if (open?.id !== id) throw new Error(`${id} is not open on this hand: start the boundary over`);
			if (from !== open.next || from > open.walk.handlers.length)
				throw new Error(`walk ${id} expects from ${open.next}, not ${from}`);
			return open.walk;
		},
		advance(sessionId, next) {
			const open = walks.get(sessionId);
			if (open !== undefined) open.next = next;
		},
		close: (sessionId) => void walks.delete(sessionId),
	};
}
