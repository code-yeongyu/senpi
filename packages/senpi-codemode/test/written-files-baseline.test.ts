import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSignature } from "../src/written-files/scan-boundaries.ts";
import { type ChangedFile, WrittenFilesTracker } from "../src/written-files/tracker.ts";
import { gate, holdRead, hookFailures, hooksReturn, openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { reportedPaths, type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

const signal = new AbortController().signal;

// senpi#7232, seventh review: a settlement that will not hook a change it claimed leaves that change for the next one.
describe("a change a settlement claims but never hooks stays for the next settlement", () => {
	it("lists the original write in a later cell when the first cell was cancelled before its settlement", async () => {
		const harness = writtenFilesHarness();
		const cancel = new AbortController();
		const [cancelled, later] = [await openCell(harness), await openCell(harness)];
		harness.workspace.write("src/a.ts", "export const a = 1;\n");

		cancel.abort();
		const outcomeCancelled = outcomeFiles(await cancelled.settle(cancel.signal));
		const outcomeLater = outcomeFiles(await later.settle(signal));
		for (const cell of [cancelled, later]) cell.close();

		expect({ outcomeCancelled, outcomeLater, hooked: reportedPaths(harness) }).toEqual({
			outcomeCancelled: { files: ["src/a.ts"], total: 1, hooked: 0 },
			outcomeLater: { files: ["src/a.ts"], total: 1, hooked: 1 },
			hooked: [harness.workspace.absolute("src/a.ts")],
		});
	});

	it("lists the original write of a file whose read back was pending when its cell was cancelled", async () => {
		const harness = writtenFilesHarness();
		const cancel = new AbortController();
		const [cancelled, later] = [await openCell(harness), await openCell(harness)];
		harness.workspace.write("src/a.ts", "export const a = 1;\n");

		const read = holdRead(harness.workspace, "readBack");
		const settling = cancelled.settle(cancel.signal);
		await read.reading;
		cancel.abort();
		cancelled.close();
		read.finish();
		const outcomeCancelled = outcomeFiles(await settling);
		const outcomeLater = outcomeFiles(await later.settle(signal));
		later.close();

		expect({ outcomeCancelled, outcomeLater, hooked: reportedPaths(harness) }).toEqual({
			outcomeCancelled: { files: ["src/a.ts"], total: 1, hooked: 0 },
			outcomeLater: { files: ["src/a.ts"], total: 1, hooked: 1 },
			hooked: [harness.workspace.absolute("src/a.ts")],
		});
	});

	it("lists the original write of a file its cell closed before dispatching, while that cell's other hook runs", async () => {
		const started = gate();
		const resume = gate();
		const harness: WrittenFilesHarness = writtenFilesHarness(async (report) => {
			if (report.input.path !== harness.workspace.absolute("src/a.ts")) return hooksReturn(harness);
			started.open();
			await resume.opened;
			return hooksReturn(harness);
		});
		const { workspace } = harness;
		const cancel = new AbortController();
		const [cellA, cellB] = [await openCell(harness), await openCell(harness)];
		workspace.write("src/a.ts", "export const a = 1;\n");
		workspace.write("src/b.ts", "export const b = 1;\n");

		const settlingA = cellA.settle(cancel.signal);
		await started.opened;
		cancel.abort();
		cellA.close();
		const outcomeB = outcomeFiles(await cellB.settle(signal));
		resume.open();
		const outcomeA = outcomeFiles(await settlingA);
		cellB.close();

		expect({ outcomeA, outcomeB, hooked: reportedPaths(harness) }).toEqual({
			outcomeA: { files: ["src/a.ts", "src/b.ts"], total: 2, hooked: 1 },
			outcomeB: { files: ["src/b.ts"], total: 1, hooked: 1 },
			hooked: [workspace.absolute("src/a.ts"), workspace.absolute("src/b.ts")],
		});
	});

	it("lists the original write in a later cell when the first settlement failed before dispatching it", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const [failing, later] = [await openCell(harness), await openCell(harness)];
		workspace.write("src/a.ts", "export const a = 1;\n");
		let opens = 0;
		workspace.beforeOpen = (path) => {
			if (path !== workspace.absolute("src/a.ts") || ++opens < 2) return;
			workspace.beforeOpen = undefined;
			throw new Error("the disk went away");
		};

		const outcomeFailing = await failing.settle(signal);
		const outcomeLater = outcomeFiles(await later.settle(signal));
		for (const cell of [failing, later]) cell.close();

		expect({ failing: outcomeFailing?.kind, outcomeLater, hooked: reportedPaths(harness) }).toEqual({
			failing: "failed",
			outcomeLater: { files: ["src/a.ts"], total: 1, hooked: 1 },
			hooked: [workspace.absolute("src/a.ts")],
		});
	});

	it("does not list again a file it reported it could not read back", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		const [cell, later] = [await openCell(harness), await openCell(harness)];
		workspace.write("src/a.ts", "export const a = 1;\n");
		let opens = 0;
		// The read back finds the file gone; it comes back unchanged (same signature) once the cell has settled.
		workspace.beforeOpen = (path) => {
			if (path !== workspace.absolute("src/a.ts") || ++opens < 2) return;
			workspace.beforeOpen = undefined;
			workspace.moveOut("src/a.ts", workspace.absolute("src/aside.ts"));
		};

		const outcome = await cell.settle(signal);
		workspace.moveOut("src/aside.ts", workspace.absolute("src/a.ts"));
		const outcomeLater = await later.settle(signal);
		for (const open of [cell, later]) open.close();

		expect({ cell: outcomeFiles(outcome), failures: hookFailures(outcome), later: outcomeLater }).toEqual({
			cell: { files: ["src/a.ts"], total: 1, hooked: 0 },
			failures: ["src/a.ts"],
			later: undefined,
		});
	});
});

const CWD = join("/", "work");

describe("a claim ending without its hooks puts back only the baseline it advanced", () => {
	it("leaves a newer change another settlement reported meanwhile reported once", async () => {
		const dirty = new Map<string, FileSignature>();
		const duringScan: Array<() => void> = [];
		let stamp = 0;
		const write = (path: string) => {
			stamp += 1;
			dirty.set(path, { size: stamp, mtimeMs: stamp, ctimeMs: stamp, ino: 1, dev: 1 });
		};
		const tracker = new WrittenFilesTracker({
			cwd: CWD,
			scan: async () => {
				const files = new Map(dirty);
				duringScan.shift()?.();
				return { kind: "files", files, head: undefined, tracked: new Set() };
			},
			stat: async (path) => dirty.get(relative(CWD, path).split(sep).join("/")),
		});
		// A claims what it lists; B and C list without hooks, so they claim nothing and record no hooked state.
		const listed = async (window: ReturnType<WrittenFilesTracker["open"]>, hooks: boolean) => {
			const change = await window.settle(async (changed: readonly ChangedFile[]) => ({
				listed: changed,
				total: changed.length,
				hooks,
			}));
			return change.kind === "changed" ? change.selection.listed.map((file) => file.path) : change.kind;
		};
		const [a, b, c] = [tracker.open(), tracker.open(), tracker.open()];
		await Promise.all([a.ready, b.ready, c.ready]);
		write("src/a.ts");

		const listedA = await listed(a, true);
		write("src/a.ts");
		// A lets go of the file without hooking it after B's scan read it, before B compares it.
		duringScan.push(() => a.skipped(join(CWD, "src", "a.ts")));
		const listedB = await listed(b, false);
		const listedC = await listed(c, false);

		expect({ listedA, listedB, listedC }).toEqual({ listedA: ["src/a.ts"], listedB: ["src/a.ts"], listedC: [] });
	});
});
