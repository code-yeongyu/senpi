import type { BoundaryWalk } from "../../core/extensions/runner.ts";

// A hosted loop's stepped boundary (senpi#5898, review L8): a `turn_end` or `agent_before_settle` walk that stops after
// each hand handler that drafts. The walk's handler list is taken once, at its first step, and kept here under an id
// the reply's `resume.walk` names; every later step sends that id back and resumes by index into the same list, so a
// handler that subscribes or unsubscribes mid-walk neither shifts nor joins this walk. The walk also holds the resume
// point its last step named, and a later step must send exactly that `from` (#6787 review L1): a repeated or skipped
// step would rerun or skip a handler, and a point past the list would end the walk silently. A step is claimed before
// its handlers run and stays in flight until its reply (#6799 review L1), so a second copy of it (a loop retrying after
// a timeout) is refused instead of running the same handler again; a step that fails releases its claim. One walk is open per loop
// session: its first step replaces any walk the loop abandoned, and its last step (a reply without `resume`) closes it.

/** The boundary walks a hand holds open between steps, one per loop session. */
export interface BoundaryWalks {
	/**
	 * Opens a session's new walk (replacing an abandoned one) with its first step claimed, and returns its id. Throws
	 * while a step of the session's walk is in flight.
	 */
	open(sessionId: string, walk: BoundaryWalk): string;
	/**
	 * Claims the step at `from` of the session's open walk with this id and returns the walk. Throws when none is open (it
	 * ended, or this hand process is new: the loop starts the boundary over), when `from` is not the point the walk's
	 * last step named, or while a step of the walk is in flight.
	 */
	resume(sessionId: string, id: string, from: number): BoundaryWalk;
	/** Ends the claimed step: records the point it named (`resume.next`), the only one the next step may send. */
	advance(sessionId: string, next: number): void;
	/** Releases a claimed step that failed, so the loop may send it again. */
	release(sessionId: string): void;
	close(sessionId: string): void;
}

export function createBoundaryWalks(): BoundaryWalks {
	const walks = new Map<
		string,
		{ readonly id: string; readonly walk: BoundaryWalk; next: number; inFlight: boolean }
	>();
	return {
		open(sessionId, walk) {
			if (walks.get(sessionId)?.inFlight === true)
				throw new Error(`a boundary walk of session ${sessionId} has a step in flight`);
			const id = crypto.randomUUID();
			walks.set(sessionId, { id, walk, next: 0, inFlight: true });
			return id;
		},
		resume(sessionId, id, from) {
			const open = walks.get(sessionId);
			if (open?.id !== id) throw new Error(`${id} is not open on this hand: start the boundary over`);
			if (open.inFlight) throw new Error(`walk ${id} has a step in flight`);
			if (from !== open.next || from > open.walk.handlers.length)
				throw new Error(`walk ${id} expects from ${open.next}, not ${from}`);
			open.inFlight = true;
			return open.walk;
		},
		advance(sessionId, next) {
			const open = walks.get(sessionId);
			if (open === undefined) return;
			open.next = next;
			open.inFlight = false;
		},
		release(sessionId) {
			const open = walks.get(sessionId);
			if (open !== undefined) open.inFlight = false;
		},
		close: (sessionId) => void walks.delete(sessionId),
	};
}
