import { describe, expect, it } from "vitest";
import { gate, hooksReturn, modelSession, openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

const signal = new AbortController().signal;
const F = "src/f.ts";
const BY_CELL = "export const f=1\n";
const BY_MODEL = "export const f = 2;\n";
const LATER = "export const f = 3;\n";

/**
 * Cell A's hook for F pauses; meanwhile the model's `write` takes F, writes it and ends as `endModel` says, before or
 * after A's hook returns. Then cell B settles, F is changed again and cell B2 settles.
 */
async function modelDuringHook(endModel: { readonly isError: boolean; readonly beforeHookReturns: boolean }) {
	const hookStarted = gate();
	const resume = gate();
	const harness: WrittenFilesHarness = writtenFilesHarness(async () => {
		if (harness.reported.length === 1) {
			hookStarted.open();
			await resume.opened;
		}
		return hooksReturn(harness);
	});
	const { workspace } = harness;
	const model = modelSession(harness);
	const [cellA, cellB, cellB2] = [await openCell(harness), await openCell(harness), await openCell(harness)];
	workspace.write(F, BY_CELL);

	const settlingA = cellA.settle(signal);
	await hookStarted.opened;
	await model.start("write-1", "write", F);
	workspace.write(F, BY_MODEL);
	if (endModel.beforeHookReturns) await model.end("write-1", endModel.isError);
	resume.open();
	const outcomeA = outcomeFiles(await settlingA);
	if (!endModel.beforeHookReturns) await model.end("write-1", endModel.isError);
	const afterEnd = outcomeFiles(await cellB.settle(signal));
	workspace.write(F, LATER);
	const laterChange = outcomeFiles(await cellB2.settle(signal));
	for (const cell of [cellA, cellB, cellB2]) cell.close();
	const hooked = harness.reported.map((report) => report.input.content);
	return { outcomeA, afterEnd, laterChange, hooked };
}

const LISTED = { files: [F], total: 1, hooked: 1 };

// senpi#7232, eighth review: neither side waits. The settlement's chain runs for the content the cell wrote, the model's
// chain for its own write, and what the call leaves is the call's to record, never the settlement's.
describe("a model write that takes a file while the settlement's hook for it runs", () => {
	it("runs one chain per write and leaves the call's content to the call when it ends after the hook", async () => {
		expect(await modelDuringHook({ isError: false, beforeHookReturns: false })).toEqual({
			outcomeA: LISTED,
			afterEnd: undefined,
			laterChange: LISTED,
			hooked: [BY_CELL, LATER],
		});
	});

	it("runs one chain per write when the call ends before the hook returns", async () => {
		expect(await modelDuringHook({ isError: false, beforeHookReturns: true })).toEqual({
			outcomeA: LISTED,
			afterEnd: undefined,
			laterChange: LISTED,
			hooked: [BY_CELL, LATER],
		});
	});

	it("does not take a failed call's content as hooked, so the next cell reports it", async () => {
		expect(await modelDuringHook({ isError: true, beforeHookReturns: true })).toEqual({
			outcomeA: LISTED,
			afterEnd: LISTED,
			laterChange: LISTED,
			hooked: [BY_CELL, BY_MODEL, LATER],
		});
	});
});

describe("a model write that starts after the settlement's hooks for the file returned", () => {
	it("is a plain sequence: one chain each, and the call's content is not a cell's change", async () => {
		const harness = writtenFilesHarness();
		const model = modelSession(harness);
		const [cellA, cellB, cellB2] = [await openCell(harness), await openCell(harness), await openCell(harness)];
		harness.workspace.write(F, BY_CELL);

		const outcomeA = outcomeFiles(await cellA.settle(signal));
		await model.start("write-1", "write", F);
		harness.workspace.write(F, BY_MODEL);
		await model.end("write-1");
		const afterEnd = outcomeFiles(await cellB.settle(signal));
		harness.workspace.write(F, LATER);
		const laterChange = outcomeFiles(await cellB2.settle(signal));
		for (const cell of [cellA, cellB, cellB2]) cell.close();

		expect({
			outcomeA,
			afterEnd,
			laterChange,
			hooked: harness.reported.map((report) => report.input.content),
		}).toEqual({
			outcomeA: LISTED,
			afterEnd: undefined,
			laterChange: LISTED,
			hooked: [BY_CELL, LATER],
		});
	});
});
