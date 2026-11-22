import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSignature } from "../src/written-files/scan-boundaries.ts";
import { WrittenFilesTracker } from "../src/written-files/tracker.ts";
import type { ChangedFile } from "../src/written-files/window.ts";
import type { WorkspaceScan } from "../src/written-files/workspace-scan.ts";

const CWD = join("/", "work");

/** A workspace whose scans report the dirty files it holds at that moment; `stamp` is the virtual write clock. */
function workspace() {
	const dirty = new Map<string, FileSignature>();
	const skips: Array<Extract<WorkspaceScan, { kind: "skipped" }>["reason"]> = [];
	const afterSnapshot: Array<() => Promise<void>> = [];
	let stamp = 0;
	let scans = 0;
	const tracker = new WrittenFilesTracker({
		cwd: CWD,
		scan: async () => {
			scans += 1;
			const reason = skips.shift();
			if (reason !== undefined) return { kind: "skipped", reason };
			const files = new Map(dirty);
			await afterSnapshot.shift()?.();
			return { kind: "files", files, head: undefined, tracked: new Set() };
		},
		stat: async (path) => dirty.get(relative(CWD, path).split(sep).join("/")),
	});
	return {
		tracker,
		skips,
		/** Work that happens while the next scan is running, after it read the workspace. */
		afterSnapshot,
		scans: () => scans,
		write(path: string): void {
			stamp += 1;
			dirty.set(path, { size: stamp, mtimeMs: stamp, ctimeMs: stamp, ino: 1, dev: 1 });
		},
	};
}

/** Lists and hooks every changed file. */
const everyFile = async (changed: readonly ChangedFile[]) => ({ listed: changed, total: changed.length, hooks: true });

async function settled(window: ReturnType<WrittenFilesTracker["open"]>): Promise<readonly string[] | string> {
	const change = await window.settle(everyFile);
	return change.kind === "changed" ? change.selection.listed.map((file) => file.path) : change.kind;
}

// senpi#7232
describe("written-files tracker", () => {
	it("reports a change once when two cells overlap: the first to settle claims it", async () => {
		const { tracker, write } = workspace();
		const first = tracker.open();
		const second = tracker.open();
		await Promise.all([first.ready, second.ready]);
		write("src/shared.ts");

		expect(await settled(first)).toEqual(["src/shared.ts"]);
		write("src/later.ts");
		expect(await settled(second)).toEqual(["src/later.ts"]);
	});

	it("skips a file whose present state a write or edit call left, and reports a later rewrite of it", async () => {
		const { tracker, write } = workspace();
		const cell = tracker.open();
		await cell.ready;
		write("src/hooked.ts");
		await tracker.noteHooked(join(CWD, "src", "hooked.ts"));
		write("src/rewritten.ts");
		await tracker.noteHooked(join(CWD, "src", "rewritten.ts"));
		write("src/rewritten.ts");

		expect(await settled(cell)).toEqual(["src/rewritten.ts"]);
	});

	it("does not report a file a write call rewrote while the settling scan was already running", async () => {
		const { tracker, afterSnapshot, write } = workspace();
		const cell = tracker.open();
		await cell.ready;
		write("src/raced.ts");
		afterSnapshot.push(async () => {
			write("src/raced.ts");
			await tracker.noteHooked(join(CWD, "src", "raced.ts"));
		});

		expect(await settled(cell)).toEqual([]);
	});

	it("turns itself off after three scans in a row run over budget, and a good scan in between resets that", async () => {
		const { tracker, skips, scans, write } = workspace();
		skips.push("over_budget");
		const flaky = tracker.open();
		await flaky.ready;
		expect(await flaky.settle(everyFile)).toEqual({ kind: "unchecked", reason: "over_budget", disabled: false });
		flaky.close();

		const healthy = tracker.open();
		await healthy.ready;
		write("src/a.ts");
		expect(await settled(healthy)).toEqual(["src/a.ts"]);
		healthy.close();

		skips.push("over_budget", "over_budget", "over_budget");
		const slow = tracker.open();
		await slow.ready;
		expect(await slow.settle(everyFile)).toEqual({ kind: "unchecked", reason: "over_budget", disabled: false });
		slow.close();
		const slowAgain = tracker.open();
		await slowAgain.ready;
		expect(await slowAgain.settle(everyFile)).toEqual({ kind: "unchecked", reason: "over_budget", disabled: false });
		slowAgain.close();
		const slowThird = tracker.open();
		await slowThird.ready;
		expect(await slowThird.settle(everyFile)).toEqual({ kind: "unchecked", reason: "over_budget", disabled: true });
		slowThird.close();
		const scansWhenOff = scans();
		const after = tracker.open();
		await after.ready;

		expect(await settled(after)).toBe("off");
		expect(scans()).toBe(scansWhenOff);
	});

	// Sixth review: only the parent segment leaves the workspace; a name that begins with two dots does not.
	it("records a hooked file named ..draft.ts at the root and below it, and ignores a hooked ../outside.ts", async () => {
		const { tracker, write } = workspace();
		const cell = tracker.open();
		await cell.ready;
		for (const path of ["..draft.ts", "src/..draft.ts", "../outside.ts"]) {
			write(path);
			await tracker.noteHooked(join(CWD, ...path.split("/")));
		}

		expect(await settled(cell)).toEqual(["../outside.ts"]);
	});

	// Eighth review: a model call that took the file after the scan read it, even one that ended, owns that look.
	it("skips a file a model call took and failed while the settling scan ran, and reports it next", async () => {
		const { tracker, afterSnapshot, write } = workspace();
		const cell = tracker.open();
		await cell.ready;
		write("src/f.ts");
		afterSnapshot.push(async () => {
			const hold = tracker.holdForCall(join(CWD, "src", "f.ts"));
			write("src/f.ts");
			await hold?.end(false);
		});

		expect([await settled(cell), await settled(cell)]).toEqual([[], ["src/f.ts"]]);
	});

	it("turns itself off at once when git is not available", async () => {
		const { tracker, skips } = workspace();
		skips.push("git_unavailable");
		const cell = tracker.open();
		await cell.ready;

		expect(await cell.settle(everyFile)).toEqual({ kind: "unchecked", reason: "git_unavailable", disabled: true });
	});
});
