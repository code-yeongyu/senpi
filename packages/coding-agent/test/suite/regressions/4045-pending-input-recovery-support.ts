import { PendingInputAppendUncertainError } from "../../../src/core/pending-input-journal.ts";
import type { PendingInputJournal, PendingInputJournalRecord } from "../../../src/core/pending-input-store.ts";

/**
 * A journal whose next `failures` appends (of `failPhase`, when set) fail their sync, with the record on file when
 * `landed`; `refuseConsumption` refuses one delivered record before anything is written (senpi#4045).
 */
export class UncertainJournal implements PendingInputJournal {
	readonly records: PendingInputJournalRecord[] = [];
	failures = 1;
	landed = true;
	reads = 0;
	failPhase: "queued" | "sending" | "delivered" | undefined;
	refuseConsumption = false;

	async append(record: PendingInputJournalRecord): Promise<void> {
		if (this.refuseConsumption && record.input.phase === "delivered") {
			this.refuseConsumption = false;
			throw new Error("EIO before consumption write");
		}
		if (this.failures > 0 && (this.failPhase === undefined || record.input.phase === this.failPhase)) {
			this.failures -= 1;
			if (this.landed) this.records.push(record);
			throw new PendingInputAppendUncertainError(record.cursor, "/sessions/test.jsonl", new Error("EIO"));
		}
		this.records.push(record);
	}

	async read(): Promise<readonly PendingInputJournalRecord[]> {
		this.reads += 1;
		return [...this.records];
	}
}
