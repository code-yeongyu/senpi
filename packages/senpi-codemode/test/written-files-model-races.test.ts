import { describe, expect, it } from "vitest";
import { holdRead, modelSession, openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

const signal = new AbortController().signal;
const F = "src/f.ts";
const BY_CELL = "export const f=1\n";
const BY_MODEL = "export const f = 2;\n";
const LATER = "export const f = 3;\n";

type Cell = Awaited<ReturnType<typeof openCell>>;

/** The contents the cells sent through the hooks for F: the model's own chain is the host's, never one of these. */
function hookedContents(harness: WrittenFilesHarness): unknown[] {
	return harness.reported
		.filter((report) => report.input.path === harness.workspace.absolute(F))
		.map((report) => report.input.content);
}

/** After the model call ended: a cell must not list the call's content, and must list a later change to F. */
async function afterTheCall(harness: WrittenFilesHarness, watching: Cell) {
	const afterEnd = outcomeFiles(await watching.settle(signal));
	harness.workspace.write(F, LATER);
	const laterChange = outcomeFiles(await watching.settle(signal));
	watching.close();
	return { afterEnd, laterChange };
}

const NOT_LOST = { afterEnd: undefined, laterChange: { files: [F], total: 1, hooked: 1 } };

// senpi#7232, eighth review: a model call that takes a file after a settlement first looked at it owns the file, and the
// settlement cedes it at whichever transition point it reaches next (selection commit or dispatch).
describe("a model write that takes a file during a settlement", () => {
	it("is ceded at the selection commit when the model write starts while the settlement selects", async () => {
		const harness = writtenFilesHarness();
		const model = modelSession(harness);
		const [cell, watching] = [await openCell(harness), await openCell(harness)];
		harness.workspace.write(F, BY_CELL);

		const sniff = holdRead(harness.workspace, "sniff");
		const settling = cell.settle(signal);
		await sniff.reading;
		await model.start("write-1", "write", F);
		harness.workspace.write(F, BY_MODEL);
		sniff.finish();
		const outcome = outcomeFiles(await settling);
		cell.close();
		const hookedBeforeEnd = hookedContents(harness);
		await model.end("write-1");
		const after = await afterTheCall(harness, watching);

		expect({ outcome, hookedBeforeEnd, ...after, hooked: hookedContents(harness) }).toEqual({
			outcome: undefined,
			hookedBeforeEnd: [],
			...NOT_LOST,
			hooked: [LATER],
		});
	});

	it("is ceded at dispatch when the model write starts between the claim and the dispatch", async () => {
		const harness = writtenFilesHarness();
		const model = modelSession(harness);
		const [cell, watching] = [await openCell(harness), await openCell(harness)];
		harness.workspace.write(F, BY_CELL);

		const readBack = holdRead(harness.workspace, "readBack");
		const settling = cell.settle(signal);
		await readBack.reading;
		await model.start("write-1", "write", F);
		harness.workspace.write(F, BY_MODEL);
		readBack.finish();
		const outcome = outcomeFiles(await settling);
		cell.close();
		const hookedBeforeEnd = hookedContents(harness);
		await model.end("write-1");
		const after = await afterTheCall(harness, watching);

		expect({ outcome, hookedBeforeEnd, ...after, hooked: hookedContents(harness) }).toEqual({
			outcome: undefined,
			hookedBeforeEnd: [],
			...NOT_LOST,
			hooked: [LATER],
		});
	});

	it("is ceded even when the model write started and ended while the settlement selected or before its dispatch", async () => {
		const outcomes: unknown[] = [];
		for (const kind of ["sniff", "readBack"] as const) {
			const harness = writtenFilesHarness();
			const model = modelSession(harness);
			const [cell, watching] = [await openCell(harness), await openCell(harness)];
			harness.workspace.write(F, BY_CELL);
			const read = holdRead(harness.workspace, kind);
			const settling = cell.settle(signal);
			await read.reading;
			await model.start("write-1", "write", F);
			harness.workspace.write(F, BY_MODEL);
			await model.end("write-1");
			read.finish();
			const outcome = outcomeFiles(await settling);
			cell.close();
			outcomes.push({ kind, outcome, ...(await afterTheCall(harness, watching)), hooked: hookedContents(harness) });
		}

		expect(outcomes).toEqual(
			["sniff", "readBack"].map((kind) => ({ kind, outcome: undefined, ...NOT_LOST, hooked: [LATER] })),
		);
	});

	it("is ceded from the list and the count on a host without hooks", async () => {
		const harness = writtenFilesHarness(undefined, { hooksRunHere: () => false });
		const model = modelSession(harness);
		const cell = await openCell(harness);
		harness.workspace.write(F, BY_CELL);
		harness.workspace.write("src/g.ts", "export const g = 1;\n");

		const sniff = holdRead(harness.workspace, "sniff");
		const settling = cell.settle(signal);
		await sniff.reading;
		await model.start("write-1", "write", F);
		sniff.finish();
		const outcome = outcomeFiles(await settling);
		await model.end("write-1");
		cell.close();

		expect({ outcome, reported: harness.reported.length }).toEqual({
			outcome: { files: ["src/g.ts"], total: 1, hooked: 0 },
			reported: 0,
		});
	});

	it("stays counted, and is never hooked, when the file is past the limit", async () => {
		const harness = writtenFilesHarness();
		const model = modelSession(harness);
		const [cell, watching] = [await openCell(harness), await openCell(harness)];
		const paths = Array.from({ length: 21 }, (_, index) => `src/f${String(index).padStart(2, "0")}.ts`);
		for (const path of paths) harness.workspace.write(path, "export {};\n");
		const last = paths[20] ?? "";

		const sniff = holdRead(harness.workspace, "sniff");
		const settling = cell.settle(signal);
		await sniff.reading;
		await model.start("write-1", "write", last);
		harness.workspace.write(last, BY_MODEL);
		sniff.finish();
		const outcome = await settling;
		cell.close();
		await model.end("write-1");
		const afterEnd = outcomeFiles(await watching.settle(signal));
		watching.close();

		expect({
			total: outcome?.kind === "written" ? outcome.report.total : outcome,
			listedLast: outcome?.kind === "written" && outcome.report.files.includes(last),
			hookedLast: harness.reported.some((report) => report.input.path === harness.workspace.absolute(last)),
			afterEnd,
		}).toEqual({ total: 21, listedLast: false, hookedLast: false, afterEnd: undefined });
	});
});
