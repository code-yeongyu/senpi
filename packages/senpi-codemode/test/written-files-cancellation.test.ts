import { describe, expect, it } from "vitest";
import { gate, holdRead, hooksReturn, openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { reportedPaths, type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

// senpi#7232, sixth review: a cell that stops early lets go of what it has not started and keeps what is running.
describe("a cancelled or closed cell's claims", () => {
	it("keeps the file whose hook is running when its cell is cancelled and closed, and lets go of the file it had not started", async () => {
		const started = gate();
		const rewrite = gate();
		const rewritten = gate();
		const resume = gate();
		const harness: WrittenFilesHarness = writtenFilesHarness(async (report) => {
			if (report.input.path !== harness.workspace.absolute("src/a.ts") || harness.reported.length > 1)
				return hooksReturn(harness);
			started.open();
			await rewrite.opened;
			harness.workspace.write("src/a.ts", "export const a = 1;\n");
			rewritten.open();
			await resume.opened;
			return hooksReturn(harness);
		});
		const { workspace } = harness;
		const signal = new AbortController().signal;
		const cancel = new AbortController();
		const [cellA, cellB] = [await openCell(harness), await openCell(harness)];
		workspace.write("src/a.ts", "export const a=1\n");
		workspace.write("src/b.ts", "export const b=1\n");

		const settlingA = cellA.settle(cancel.signal);
		await started.opened;
		cancel.abort();
		cellA.close();
		rewrite.open();
		await rewritten.opened;
		workspace.write("src/b.ts", "export const b = 2;\n");
		const outcomeB = outcomeFiles(await cellB.settle(signal));
		const hookedWhileRunning = [...reportedPaths(harness)];
		resume.open();
		const outcomeA = outcomeFiles(await settlingA);
		const cellC = await openCell(harness);
		const outcomeC = await cellC.settle(signal);
		workspace.write("src/a.ts", "export const a = 2;\n");
		const cellD = await openCell(harness);
		const outcomeD = outcomeFiles(await cellD.settle(signal));
		for (const cell of [cellB, cellC, cellD]) cell.close();

		const [a, b] = [workspace.absolute("src/a.ts"), workspace.absolute("src/b.ts")];
		expect({ outcomeA, outcomeB, hookedWhileRunning, outcomeC, outcomeD, hooked: reportedPaths(harness) }).toEqual({
			outcomeA: { files: ["src/a.ts", "src/b.ts"], total: 2, hooked: 1 },
			outcomeB: { files: ["src/b.ts"], total: 1, hooked: 1 },
			hookedWhileRunning: [a, b],
			outcomeC: undefined,
			outcomeD: { files: ["src/a.ts"], total: 1, hooked: 1 },
			hooked: [a, b, a],
		});
	});

	it("starts no hook and keeps no file when the cell was cancelled before its settlement", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const cancel = new AbortController();
		const [cancelled, later] = [await openCell(harness), await openCell(harness)];
		workspace.write("src/a.ts", "export const a = 1;\n");

		cancel.abort();
		const outcomeCancelled = outcomeFiles(await cancelled.settle(cancel.signal));
		workspace.write("src/a.ts", "export const a = 2;\n");
		const outcomeLater = outcomeFiles(await later.settle(new AbortController().signal));
		for (const cell of [cancelled, later]) cell.close();

		expect({ outcomeCancelled, outcomeLater, hooked: reportedPaths(harness) }).toEqual({
			outcomeCancelled: { files: ["src/a.ts"], total: 1, hooked: 0 },
			outcomeLater: { files: ["src/a.ts"], total: 1, hooked: 1 },
			hooked: [workspace.absolute("src/a.ts")],
		});
	});

	it("starts no hook and claims nothing when the cell closes while its settlement is still selecting", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const signal = new AbortController().signal;
		const [closing, later] = [await openCell(harness), await openCell(harness)];
		workspace.write("src/a.ts", "export const a = 1;\n");

		const sniff = holdRead(workspace, "sniff");
		const settlingClosed = closing.settle(signal);
		await sniff.reading;
		closing.close();
		sniff.finish();
		const outcomeClosed = outcomeFiles(await settlingClosed);
		workspace.write("src/a.ts", "export const a = 2;\n");
		const outcomeLater = outcomeFiles(await later.settle(signal));
		later.close();

		expect({ outcomeClosed, outcomeLater, hooked: reportedPaths(harness) }).toEqual({
			outcomeClosed: { files: ["src/a.ts"], total: 1, hooked: 0 },
			outcomeLater: { files: ["src/a.ts"], total: 1, hooked: 1 },
			hooked: [workspace.absolute("src/a.ts")],
		});
	});
});
