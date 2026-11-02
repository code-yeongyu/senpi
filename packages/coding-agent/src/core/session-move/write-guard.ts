import { headerSessionId, ownershipStep, SessionMovedAwayError, type SessionOwnership } from "./ownership.ts";

interface EntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly id?: unknown;
}

/**
 * The session-manager write funnel asks this before every persisted write. It folds only the entries appended since
 * the last call (the funnel appends in place), and starts over when the entry array is replaced by a load or branch.
 */
export class SessionWriteGuard {
	private source: readonly EntryLike[] | undefined;
	private seen = 0;
	private sessionId: string | undefined;
	private verdict: SessionOwnership = { writable: true };

	assertWritable(entries: readonly EntryLike[], entry: EntryLike, sessionFile: string): void {
		const ownership = this.current(entries);
		if (ownership.writable) return;
		if (ownershipStep(ownership, entry, this.sessionId).kind !== "apply")
			throw new SessionMovedAwayError(sessionFile, ownership);
	}

	assertRewritable(entries: readonly EntryLike[], sessionFile: string): void {
		const ownership = this.current(entries);
		if (!ownership.writable) throw new SessionMovedAwayError(sessionFile, ownership);
	}

	isWritable(entries: readonly EntryLike[]): boolean {
		return this.current(entries).writable;
	}

	private current(entries: readonly EntryLike[]): SessionOwnership {
		if (entries !== this.source || entries.length < this.seen) {
			this.source = entries;
			this.seen = 0;
			this.sessionId = headerSessionId(entries);
			this.verdict = { writable: true };
		}
		for (; this.seen < entries.length; this.seen += 1) {
			const entry = entries[this.seen];
			if (entry === undefined) continue;
			const step = ownershipStep(this.verdict, entry, this.sessionId);
			if (step.kind === "apply") this.verdict = step.next;
		}
		return this.verdict;
	}
}
