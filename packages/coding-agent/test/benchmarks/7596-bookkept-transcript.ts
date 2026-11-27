import { SessionManager } from "../../src/core/session-manager.ts";

/** What a bookkept session holds, for a reader to check a fold against. */
export interface BookkeptTranscript {
	readonly file: string;
	readonly sessionId: string;
	/** Bookkeeping entries written before the compaction window. */
	readonly beforeWindow: number;
	/** Bookkeeping entries written inside the window. */
	readonly inWindow: number;
	/** `seq` of the newest `session-lifecycle` record. */
	readonly lastSeq: number;
	/** Custody record ids in the order their first record was written, with the state of their last record. */
	readonly custody: readonly { id: string; state: string }[];
}

/** The data of one `session-lifecycle` entry, as a running session writes it. */
export function lifecycleRecord(sessionId: string, seq: number): Record<string, unknown> {
	return {
		state: "running",
		sessionId,
		seq,
		epoch: 1,
		epochOrigin: "automatic",
		humanInputRevision: 0,
		selfSettleEligible: false,
		runPaused: false,
		since: "2026-01-01T00:00:00.000Z",
		role: "root",
		rootSessionId: sessionId,
		waitingOn: { background: [{ source: "monitor", activeCount: 1, items: "x".repeat(400) }] },
	};
}

/** The data of one `work-custody` entry carrying a delivery payload. */
export function custodyRecord(sessionId: string, id: string, state: string): Record<string, unknown> {
	return {
		id,
		key: `delivery:${id}`,
		kind: "background",
		state,
		sessionId,
		payload: { message: { customType: "wake", content: "y".repeat(1200), display: false } },
	};
}

/**
 * A compacted session shaped like a long-lived one (senpi#7596), still open in the manager that compacted it: every
 * turn is followed by the lifecycle records a run leaves (`perTurn` `session-lifecycle` transitions and one custody
 * record opened then settled), then one compaction keeps only the last turn.
 */
export function bookkeptSession(
	dir: string,
	turns: number,
	perTurn = 3,
): { manager: SessionManager; written: BookkeptTranscript } {
	const manager = SessionManager.create(dir, dir);
	const sessionId = manager.getSessionId();
	let seq = 0;
	const custody: { id: string; state: string }[] = [];
	for (let index = 0; index < turns; index++) {
		manager.appendMessage({ role: "user", content: `turn ${index} ${"a".repeat(600)}`, timestamp: Date.now() });
		for (let step = 0; step < perTurn; step++)
			manager.appendCustomEntry("session-lifecycle", lifecycleRecord(sessionId, ++seq));
		const id = `custody-${index}`;
		manager.appendCustomEntry("work-custody", custodyRecord(sessionId, id, "open"));
		manager.appendCustomEntry("work-custody", custodyRecord(sessionId, id, "settled"));
		custody.push({ id, state: "settled" });
	}
	const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	manager.appendCustomEntry("session-lifecycle", lifecycleRecord(sessionId, ++seq));
	manager.appendCustomEntry("work-custody", custodyRecord(sessionId, "custody-open", "open"));
	custody.push({ id: "custody-open", state: "open" });
	manager.appendCompaction("summary of the earlier turns", kept, 1000);
	manager.appendMessage({ role: "user", content: "after the compaction", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("the session has no file");
	return {
		manager,
		written: { file, sessionId, beforeWindow: turns * (perTurn + 2), inWindow: 2, lastSeq: seq, custody },
	};
}

/** Writes `bookkeptSession` to its file and returns what it holds. */
export function writeBookkeptTranscript(dir: string, turns: number, perTurn = 3): BookkeptTranscript {
	return bookkeptSession(dir, turns, perTurn).written;
}
