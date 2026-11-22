import { describe, expect, it } from "vitest";
import { SOURCE_FILE_SNIFF_BYTES } from "../src/written-files/source-file.ts";
import {
	claimRound,
	claimRoundExpected,
	hookFailures,
	hooksReturn,
	openCell,
	outcomeFiles,
} from "./eval/written-files-barriers.ts";
import {
	FakeWorkspace,
	reportedPaths,
	type WrittenFilesHarness,
	writtenFilesHarness,
} from "./eval/written-files-fakes.ts";

const absolute = (...paths: string[]) => paths.map((path) => new FakeWorkspace().absolute(path));

// senpi#7232, sixth review: each way a hook can end ends the cell's claim on that file, and records what it left.
describe("a cell's claim on a file it hooks ends with that file's hook", () => {
	it("claims, hooks, lets go of and records the rewrite of ..draft.ts at the root and below it like any other file", async () => {
		const [first, second] = ["..draft.ts", "src/..draft.ts"];
		const round = await claimRound(first, second, async (harness) => hooksReturn(harness));

		expect(round).toEqual({
			a: { files: [first, second], total: 2, hooked: 2 },
			failures: [],
			...claimRoundExpected(first, second),
			hooked: absolute(first, second, first, second),
		});
	});

	it("lets go of a file and records its rewrite when the hook throws", async () => {
		const [first, second] = ["src/a.ts", "src/b.ts"];
		const round = await claimRound(first, second, async () => {
			throw new Error("the formatter crashed");
		});

		expect(round).toEqual({
			a: { files: [first, second], total: 2, hooked: 1 },
			failures: [first],
			...claimRoundExpected(first, second),
			hooked: absolute(first, second, first, second),
		});
	});

	it("lets go of a file and records its rewrite when the host's handler deadline ends the hook", async () => {
		const [first, second] = ["src/a.ts", "src/b.ts"];
		const round = await claimRound(first, second, async (harness) => ({
			...hooksReturn(harness),
			failures: [{ extensionPath: "formatter.ts", error: "tool_result handler timed out" }],
		}));

		expect(round).toEqual({
			a: { files: [first, second], total: 2, hooked: 2 },
			failures: [first],
			...claimRoundExpected(first, second),
			hooked: absolute(first, second, first, second),
		});
	});

	// Seventh review: the claim lasts until the whole handler chain returns; a handler that outlives it writes unowned.
	it("lets the cell that settles next report a write a timed-out handler makes after the chain returned", async () => {
		let lateWrite: () => void = () => {};
		const harness: WrittenFilesHarness = writtenFilesHarness(async () => {
			lateWrite = () => harness.workspace.write("src/a.ts", "export const a = 1;\n");
			return {
				...hooksReturn(harness),
				failures: [{ extensionPath: "formatter.ts", error: "tool_result handler timed out" }],
			};
		});
		const signal = new AbortController().signal;
		const [cellA, cellB] = [await openCell(harness), await openCell(harness)];
		harness.workspace.write("src/a.ts", "export const a=1\n");

		const outcomeA = await cellA.settle(signal);
		lateWrite();
		const outcomeB = outcomeFiles(await cellB.settle(signal));
		for (const cell of [cellA, cellB]) cell.close();

		expect({
			a: outcomeFiles(outcomeA),
			failures: hookFailures(outcomeA),
			b: outcomeB,
			hooked: reportedPaths(harness),
		}).toEqual({
			a: { files: ["src/a.ts"], total: 1, hooked: 1 },
			failures: ["src/a.ts"],
			b: { files: ["src/a.ts"], total: 1, hooked: 1 },
			hooked: absolute("src/a.ts", "src/a.ts"),
		});
	});

	it("lets go of a file it cannot read back without starting its hook", async () => {
		const [first, second] = ["src/a.ts", "src/b.ts"];
		// A never dispatches `first`: the only hook for it is B2's, so the list below starts with `second`.
		const round = await claimRound(
			first,
			second,
			async (harness) => hooksReturn(harness),
			(workspace) => {
				workspace.afterRead = async (path, limit) => {
					if (limit > SOURCE_FILE_SNIFF_BYTES || path !== workspace.absolute(first)) return;
					workspace.afterRead = undefined;
					workspace.remove(first);
				};
			},
		);

		expect(round).toEqual({
			a: { files: [first, second], total: 2, hooked: 1 },
			failures: [first],
			...claimRoundExpected(first, second),
			hooked: absolute(second, first, second),
		});
	});

	it("lets a cell a hook starts settle on its own writes while the outer cell still owns the file it is hooking", async () => {
		let nestedOutcome: unknown;
		const harness: WrittenFilesHarness = writtenFilesHarness(async (report) => {
			const { workspace } = harness;
			if (report.input.path !== workspace.absolute("src/a.ts") || harness.reported.length > 1)
				return hooksReturn(harness);
			workspace.write("src/a.ts", "export const a = 1;\n");
			const nested = await openCell(harness);
			workspace.write("src/nested.ts", "export const nested = 1;\n");
			nestedOutcome = outcomeFiles(await nested.settle(new AbortController().signal));
			nested.close();
			return hooksReturn(harness);
		});
		const { workspace } = harness;
		const signal = new AbortController().signal;
		const cell = await openCell(harness);
		workspace.write("src/a.ts", "export const a=1\n");

		const outcome = outcomeFiles(await cell.settle(signal));
		const later = await openCell(harness);
		const laterOutcome = await later.settle(signal);
		for (const open of [cell, later]) open.close();

		expect({ outcome, nested: nestedOutcome, later: laterOutcome, hooked: reportedPaths(harness) }).toEqual({
			outcome: { files: ["src/a.ts"], total: 1, hooked: 1 },
			nested: { files: ["src/nested.ts"], total: 1, hooked: 1 },
			later: undefined,
			hooked: [workspace.absolute("src/a.ts"), workspace.absolute("src/nested.ts")],
		});
	});
});
