import { SessionManager } from "../../src/core/session-manager.ts";

/** What `writeBookkeptTranscript` wrote, for a reader to check a fold against. */
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

/**
 * Writes a compacted session shaped like a long-lived one (senpi#7596): every turn is followed by the lifecycle
 * records a run leaves (`perTurn` `session-lifecycle` transitions and one custody record opened then settled), then
 * one compaction keeps only the last turn.
 */
export function writeBookkeptTranscript(dir: string, turns: number, perTurn = 3): BookkeptTranscript {
	const manager = SessionManager.create(dir, dir);
	const sessionId = manager.getSessionId();
	let seq = 0;
	const lifecycle = () =>
		manager.appendCustomEntry("session-lifecycle", {
			state: "running",
			sessionId,
			seq: ++seq,
			epoch: 1,
			epochOrigin: "automatic",
			humanInputRevision: 0,
			selfSettleEligible: false,
			runPaused: false,
			since: "2026-01-01T00:00:00.000Z",
			role: "root",
			rootSessionId: sessionId,
			waitingOn: { background: [{ source: "monitor", activeCount: 1, items: "x".repeat(400) }] },
		});
	const custody: { id: string; state: string }[] = [];
	const custodyRecord = (id: string, state: string) =>
		manager.appendCustomEntry("work-custody", {
			id,
			key: `delivery:${id}`,
			kind: "background",
			state,
			sessionId,
			payload: { message: { customType: "wake", content: "y".repeat(1200), display: false } },
		});
	for (let index = 0; index < turns; index++) {
		manager.appendMessage({ role: "user", content: `turn ${index} ${"a".repeat(600)}`, timestamp: Date.now() });
		for (let step = 0; step < perTurn; step++) lifecycle();
		const id = `custody-${index}`;
		custodyRecord(id, "open");
		custodyRecord(id, "settled");
		custody.push({ id, state: "settled" });
	}
	const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	lifecycle();
	custodyRecord("custody-open", "open");
	custody.push({ id: "custody-open", state: "open" });
	manager.appendCompaction("summary of the earlier turns", kept, 1000);
	manager.appendMessage({ role: "user", content: "after the compaction", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("the session has no file");
	return { file, sessionId, beforeWindow: turns * (perTurn + 2), inWindow: 2, lastSeq: seq, custody };
}
