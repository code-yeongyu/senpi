import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleHistory } from "../../../src/core/lifecycle-history.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import { writeBookkeptTranscript } from "../../benchmarks/7596-bookkept-transcript.ts";

const BOOKKEEPING = new Set(["session-lifecycle", "work-custody"]);
const bookkeeping = (entries: readonly SessionEntry[]) =>
	entries.filter((entry) => entry.type === "custom" && BOOKKEEPING.has(entry.customType));
const dataOf = (entry: SessionEntry): Record<string, unknown> =>
	entry.type === "custom" && typeof entry.data === "object" && entry.data !== null
		? (entry.data as Record<string, unknown>)
		: {};

// senpi#7596: a compacted session kept every lifecycle bookkeeping entry resident, in the mirror and in the fold.
describe("#7596 lifecycle bookkeeping written before a compaction window", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const session = () => {
		const dir = mkdtempSync(join(tmpdir(), "s7596-"));
		dirs.push(dir);
		const written = writeBookkeptTranscript(dir, 12);
		return { written, reopened: SessionManager.open(written.file, dir) };
	};

	it("is not walked by a branch read of the reopened session", () => {
		// given a session whose 12 turns each left five bookkeeping entries before the compaction window
		const { written, reopened } = session();

		// when
		const branch = reopened.getBranch();

		// then only the bookkeeping written inside the window is on the branch
		expect(bookkeeping(branch)).toHaveLength(written.inWindow);
		expect(branch.some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("is folded to the records restoration reads", () => {
		// given
		const { written, reopened } = session();

		// when
		const folded = reopened.reduceHistory(lifecycleHistory);

		// then one lifecycle record, the newest, and one custody record per id in first-written order
		const lifecycle = folded.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle");
		expect(lifecycle.map((entry) => dataOf(entry).seq)).toEqual([written.lastSeq]);
		const custody = folded.filter((entry) => entry.type === "custom" && entry.customType === "work-custody");
		expect(custody.map((entry) => ({ id: dataOf(entry).id, state: dataOf(entry).state }))).toEqual(written.custody);
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
