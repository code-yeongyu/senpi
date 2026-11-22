import { describe, expect, it } from "vitest";
import { holdRead, outcomeFiles } from "./eval/written-files-barriers.ts";
import {
	cellListing,
	reportedPaths,
	type WrittenFilesHarness,
	writtenFilesHarness,
} from "./eval/written-files-fakes.ts";

// senpi#7232, fourth review: an unknown is never taken for an answer, and a hook's rewrite belongs to its own cell.
describe("written files settle only what is known to be the cell's", () => {
	it("rejects a case variant of node_modules when the identity lookup fails, and lists it when the canonical one is absent", async () => {
		const failing = writtenFilesHarness();
		failing.workspace.identityFailures.add(failing.workspace.absolute("node_modules"));
		const absent = writtenFilesHarness();
		const write = (harness: WrittenFilesHarness) => () =>
			harness.workspace.write("NODE_MODULES/example.ts", "export const example = 1;\n");

		const listedOnFailure = await cellListing(failing, write(failing));
		const listedOnAbsence = await cellListing(absent, write(absent));

		expect({ listed: listedOnFailure, hooked: reportedPaths(failing), reads: failing.workspace.reads }).toEqual({
			listed: undefined,
			hooked: [],
			reads: [],
		});
		expect({ listed: listedOnAbsence, hooked: reportedPaths(absent) }).toEqual({
			listed: ["NODE_MODULES/example.ts"],
			hooked: [absent.workspace.absolute("NODE_MODULES/example.ts")],
		});
	});

	it("drops a staged file taken out of the index and ignored, and still lists a dirty tracked file restored to HEAD", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const committed = "export const value = 1;\n";
		workspace.write("src/restore.ts", committed);
		workspace.commit();
		workspace.write("src/restore.ts", "export const value = 2;\n");
		workspace.write("src/new.ts", "export const staged = 1;\n");
		workspace.stage("src/new.ts");

		const listed = await cellListing(harness, () => {
			workspace.untrack("src/new.ts");
			workspace.ignore("src/new.ts");
			workspace.write("src/new.ts", "export const rewritten: number = 'x';\n");
			workspace.write("src/restore.ts", committed);
		});

		expect({ listed, hooked: reportedPaths(harness) }).toEqual({
			listed: ["src/restore.ts"],
			hooked: [workspace.absolute("src/restore.ts")],
		});
	});

	it("attributes a file cell A's hook rewrites to A alone when cell B settles while that hook is running", async () => {
		let formatted: () => void = () => {};
		const hookRewrote = new Promise<void>((resolve) => {
			formatted = resolve;
		});
		let resume: () => void = () => {};
		const hookResumes = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const harness: WrittenFilesHarness = writtenFilesHarness(async () => {
			const done = { toolCallId: `cell/reported-${harness.reported.length}`, result: undefined, failures: [] };
			if (harness.reported.length > 1) return done;
			// The formatter rewrites the file, then pauses before its handler returns.
			harness.workspace.write("src/a.ts", "export const a = 1;\n");
			formatted();
			await hookResumes;
			return done;
		});
		const { workspace, writtenFiles, ctx } = harness;
		const signal = new AbortController().signal;
		const cellA = writtenFiles.open(ctx);
		await cellA.ready;
		const cellB = writtenFiles.open(ctx);
		await cellB.ready;
		workspace.write("src/a.ts", "export const a=1\n");

		const settledA = cellA.settle(signal);
		await hookRewrote;
		const outcomeB = await cellB.settle(signal);
		resume();
		const outcomeA = await settledA;
		const cellC = writtenFiles.open(ctx);
		await cellC.ready;
		const outcomeC = await cellC.settle(signal);
		for (const cell of [cellA, cellB, cellC]) cell.close();

		expect({
			a: outcomeA?.kind === "written" ? outcomeA.report.files : outcomeA,
			b: outcomeB,
			c: outcomeC,
			hooked: reportedPaths(harness),
		}).toEqual({ a: ["src/a.ts"], b: undefined, c: undefined, hooked: [workspace.absolute("src/a.ts")] });
	});

	// Fifth review: a cell owns only the files it will send through the hooks, and only until it decides not to.
	it("leaves a file past the limit unclaimed, so a cell settling during the first cell's hook lists and hooks its rewrite", async () => {
		const paths = Array.from({ length: 21 }, (_, index) => `src/f${String(index).padStart(2, "0")}.ts`);
		let started: () => void = () => {};
		const hookStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let resume: () => void = () => {};
		const hookResumes = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const harness: WrittenFilesHarness = writtenFilesHarness(async () => {
			if (harness.reported.length === 1) {
				started();
				await hookResumes;
			}
			return { toolCallId: `cell/reported-${harness.reported.length}`, result: undefined, failures: [] };
		});
		const { workspace, writtenFiles, ctx } = harness;
		const signal = new AbortController().signal;
		const cellA = writtenFiles.open(ctx);
		await cellA.ready;
		const cellB = writtenFiles.open(ctx);
		await cellB.ready;
		for (const path of paths) workspace.write(path, `export const path = "${path}";\n`);

		const settledA = cellA.settle(signal);
		await hookStarted;
		workspace.write("src/f20.ts", "export const rewritten = 1;\n");
		const outcomeB = await cellB.settle(signal);
		resume();
		const outcomeA = await settledA;
		// No claim outlives either settlement: a later cell lists a rewrite of a file each of them hooked.
		const cellC = writtenFiles.open(ctx);
		await cellC.ready;
		workspace.write("src/f00.ts", "export const again = 1;\n");
		workspace.write("src/f20.ts", "export const again = 1;\n");
		const outcomeC = await cellC.settle(signal);
		for (const cell of [cellA, cellB, cellC]) cell.close();

		const listedA = paths.slice(0, 20);
		expect({
			a: outcomeFiles(outcomeA),
			b: outcomeFiles(outcomeB),
			c: outcomeFiles(outcomeC),
			hooked: reportedPaths(harness),
		}).toEqual({
			a: { files: listedA, total: 21, hooked: 20 },
			b: { files: ["src/f20.ts"], total: 1, hooked: 1 },
			c: { files: ["src/f00.ts", "src/f20.ts"], total: 2, hooked: 2 },
			hooked: [
				workspace.absolute("src/f00.ts"),
				workspace.absolute("src/f20.ts"),
				...listedA.slice(1).map((path) => workspace.absolute(path)),
				workspace.absolute("src/f00.ts"),
				workspace.absolute("src/f20.ts"),
			],
		});
	});

	it("starts no hook for a file whose read back was pending when the cell was cancelled, and lets go of it", async () => {
		const harness = writtenFilesHarness();
		const { workspace, writtenFiles, ctx } = harness;
		const controller = new AbortController();
		const cancelled = writtenFiles.open(ctx);
		await cancelled.ready;
		const later = writtenFiles.open(ctx);
		await later.ready;
		workspace.write("src/a.ts", "export const a = 1;\n");

		const cancelledRead = holdRead(workspace, "readBack");
		const settlingCancelled = cancelled.settle(controller.signal);
		await cancelledRead.reading;
		controller.abort();
		cancelled.close();
		cancelledRead.finish();
		const outcomeCancelled = await settlingCancelled;
		const hookedWhenCancelled = [...reportedPaths(harness)];
		// The normal path, through the same held read: a cell that is not cancelled sends its rewrite through the hooks.
		workspace.write("src/a.ts", "export const a = 2;\n");
		const laterRead = holdRead(workspace, "readBack");
		const settlingLater = later.settle(new AbortController().signal);
		await laterRead.reading;
		laterRead.finish();
		const outcomeLater = await settlingLater;
		later.close();

		expect({
			cancelled: outcomeFiles(outcomeCancelled),
			hookedWhenCancelled,
			later: outcomeFiles(outcomeLater),
			hooked: reportedPaths(harness),
		}).toEqual({
			cancelled: { files: ["src/a.ts"], total: 1, hooked: 0 },
			hookedWhenCancelled: [],
			later: { files: ["src/a.ts"], total: 1, hooked: 1 },
			hooked: [workspace.absolute("src/a.ts")],
		});
	});
});
