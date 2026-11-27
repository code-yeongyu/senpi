import { describe, expect, it } from "vitest";
import { holdRead, hookFailures, modelSession, openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

const signal = new AbortController().signal;
const F = "src/f.ts";
const BY_CELL = "export const f=1\n";

/** How the read back of F ends once the model call has taken F during it. */
type ReadBackEnd = "fails" | "oversized" | "cancelled";

/** Every content the cells sent through the hooks: the model's own chain is the host's, never one of these. */
function hookedContents(harness: WrittenFilesHarness): unknown[] {
	return harness.reported.map((report) => report.input.content);
}

/**
 * Cell A's read back of F is held; meanwhile the model's `write` takes F. The read back then ends as `end` says, A
 * settles, and the model call fails without changing F. Then cell B settles.
 */
async function takeoverDuringReadBack(end: ReadBackEnd) {
	const harness = writtenFilesHarness();
	const { workspace } = harness;
	const model = modelSession(harness);
	const cancel = new AbortController();
	const [cellA, cellB] = [await openCell(harness), await openCell(harness)];
	workspace.write(F, BY_CELL);

	const readBack = holdRead(workspace, "readBack");
	const settlingA = cellA.settle(cancel.signal);
	await readBack.reading;
	await model.start("write-1", "write", F);
	if (end === "fails") workspace.readFaults.set(workspace.absolute(F), "unreadable");
	if (end === "oversized") workspace.readFaults.set(workspace.absolute(F), "oversized");
	if (end === "cancelled") cancel.abort();
	readBack.finish();
	const outcomeA = await settlingA;
	cellA.close();
	const hookedByA = hookedContents(harness);
	await model.end("write-1", true);
	const outcomeB = await cellB.settle(signal);
	cellB.close();
	return {
		a: outcomeFiles(outcomeA),
		aFailures: hookFailures(outcomeA),
		hookedByA,
		b: outcomeFiles(outcomeB),
		bFailures: hookFailures(outcomeB),
		hooked: hookedContents(harness),
	};
}

// senpi#7232, ninth review: a file a model call took during the read back is the call's, however the read back ends.
describe("a model write that takes a file while the settlement reads it back", () => {
	it("is ceded when the read back then fails: no failure, no count, no hook, and the baseline is kept", async () => {
		expect(await takeoverDuringReadBack("fails")).toEqual({
			a: undefined,
			aFailures: [],
			hookedByA: [],
			b: { files: [F], total: 1, hooked: 1 },
			bFailures: [],
			hooked: [BY_CELL],
		});
	});

	it("is ceded when the file read back is oversized: no failure, no count, no hook, and the baseline is kept", async () => {
		expect(await takeoverDuringReadBack("oversized")).toEqual({
			a: undefined,
			aFailures: [],
			hookedByA: [],
			b: { files: [F], total: 1, hooked: 1 },
			bFailures: [],
			hooked: [BY_CELL],
		});
	});

	it("is ceded when the cell is cancelled during the read back", async () => {
		expect(await takeoverDuringReadBack("cancelled")).toEqual({
			a: undefined,
			aFailures: [],
			hookedByA: [],
			b: { files: [F], total: 1, hooked: 1 },
			bFailures: [],
			hooked: [BY_CELL],
		});
	});
});

describe("a file still the settlement's whose read back fails", () => {
	it("is counted and reported as a read failure, and not listed again", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const [cell, later] = [await openCell(harness), await openCell(harness)];
		workspace.write(F, BY_CELL);

		const readBack = holdRead(workspace, "readBack");
		const settling = cell.settle(signal);
		await readBack.reading;
		workspace.readFaults.set(workspace.absolute(F), "unreadable");
		readBack.finish();
		const outcome = await settling;
		const outcomeLater = await later.settle(signal);
		for (const open of [cell, later]) open.close();

		expect({
			cell: outcomeFiles(outcome),
			failures: hookFailures(outcome),
			later: outcomeFiles(outcomeLater),
			hooked: hookedContents(harness),
		}).toEqual({ cell: { files: [F], total: 1, hooked: 0 }, failures: [F], later: undefined, hooked: [] });
	});
});
