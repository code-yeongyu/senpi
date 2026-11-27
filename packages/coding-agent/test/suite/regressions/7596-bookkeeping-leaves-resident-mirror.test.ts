import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleHistory } from "../../../src/core/lifecycle-history.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import {
	bookkeptSession,
	custodyRecord,
	lifecycleRecord,
	writeBookkeptTranscript,
} from "../../benchmarks/7596-bookkept-transcript.ts";

const BOOKKEEPING = new Set(["session-lifecycle", "work-custody"]);
const bookkeeping = (entries: readonly SessionEntry[]) =>
	entries.filter((entry) => entry.type === "custom" && BOOKKEEPING.has(entry.customType));
const dataOf = (entry: SessionEntry): Record<string, unknown> =>
	entry.type === "custom" && typeof entry.data === "object" && entry.data !== null
		? (entry.data as Record<string, unknown>)
		: {};
const recordsOf = (entries: readonly SessionEntry[], customType: string) =>
	entries.filter((entry) => entry.type === "custom" && entry.customType === customType).map(dataOf);
const custodyOf = (entries: readonly SessionEntry[]) =>
	recordsOf(entries, "work-custody").map((data) => ({ id: data.id, state: data.state }));

// senpi#7596: a compacted session kept every lifecycle bookkeeping entry resident, in the mirror and in the fold.
describe("#7596 lifecycle bookkeeping written before a compaction window", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const tempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "s7596-"));
		dirs.push(dir);
		return dir;
	};
	const session = () => {
		const dir = tempDir();
		const written = writeBookkeptTranscript(dir, 12);
		return { written, reopened: SessionManager.open(written.file, dir) };
	};

	it("is not walked by a branch read of the session that compacted", () => {
		// given a live session whose 12 turns each left five bookkeeping entries, right after its compaction
		const { manager, written } = bookkeptSession(tempDir(), 12);

		// when
		const branch = manager.getBranch();

		// then only the bookkeeping written inside the window is on the branch
		expect(bookkeeping(branch)).toHaveLength(written.inWindow);
		expect(branch.some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("is not walked by a branch read of the reopened session", () => {
		// given the same session read back from its file
		const { written, reopened } = session();

		// when
		const branch = reopened.getBranch();

		// then
		expect(bookkeeping(branch)).toHaveLength(written.inWindow);
		expect(branch.some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("is folded to the records restoration reads", () => {
		// given
		const { written, reopened } = session();

		// when
		const folded = reopened.reduceHistory(lifecycleHistory);

		// then one lifecycle record, the newest, and one custody record per id in first-written order
		expect(recordsOf(folded, "session-lifecycle").map((data) => data.seq)).toEqual([written.lastSeq]);
		expect(custodyOf(folded)).toEqual(written.custody);
	});

	it("replaces a folded record where it stands when a newer one is appended", () => {
		// given a fold already taken, which later appends extend
		const { written, reopened } = session();
		reopened.reduceHistory(lifecycleHistory);

		// when a newer lifecycle record, the settlement of the open custody record and the cancellation of an earlier one arrive
		reopened.appendCustomEntry("session-lifecycle", lifecycleRecord(written.sessionId, written.lastSeq + 1));
		reopened.appendCustomEntry("work-custody", custodyRecord(written.sessionId, "custody-open", "settled"));
		reopened.appendCustomEntry("work-custody", custodyRecord(written.sessionId, "custody-3", "cancelled"));
		const folded = reopened.reduceHistory(lifecycleHistory);

		// then each took the place of the record it supersedes: the order is still that of the first records
		expect(recordsOf(folded, "session-lifecycle").map((data) => data.seq)).toEqual([written.lastSeq + 1]);
		expect(custodyOf(folded)).toEqual(
			written.custody.map(({ id }) => ({ id, state: id === "custody-3" ? "cancelled" : "settled" })),
		);
	});

	it("keeps another session's records apart, and the first of two records with the same seq", () => {
		// given
		const { written, reopened } = session();

		// when another session's records and a second record with this session's newest seq are appended
		reopened.appendCustomEntry("session-lifecycle", lifecycleRecord("another-session", 1));
		reopened.appendCustomEntry("work-custody", custodyRecord("another-session", "custody-open", "settled"));
		reopened.appendCustomEntry("session-lifecycle", {
			...lifecycleRecord(written.sessionId, written.lastSeq),
			since: "2027-01-01T00:00:00.000Z",
		});
		const folded = reopened.reduceHistory(lifecycleHistory);

		// then
		expect(recordsOf(folded, "session-lifecycle").map((data) => [data.sessionId, data.seq, data.since])).toEqual([
			[written.sessionId, written.lastSeq, "2026-01-01T00:00:00.000Z"],
			["another-session", 1, "2026-01-01T00:00:00.000Z"],
		]);
		expect(
			recordsOf(folded, "work-custody")
				.filter((data) => data.id === "custody-open")
				.map((data) => [data.sessionId, data.state]),
		).toEqual([
			[written.sessionId, "open"],
			["another-session", "settled"],
		]);
	});

	it("is still read from the file by a full-history reader", () => {
		// given
		const { written, reopened } = session();

		// when
		const history = reopened.getEntries();

		// then
		expect(bookkeeping(history)).toHaveLength(written.beforeWindow + written.inWindow);
	});
});
