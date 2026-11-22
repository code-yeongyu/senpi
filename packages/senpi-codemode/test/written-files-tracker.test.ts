import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSignature } from "../src/written-files/scan-boundaries.ts";
import { WrittenFilesTracker } from "../src/written-files/tracker.ts";
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
			return { kind: "files", files, head: undefined };
		},
		stat: async (path) => dirty.get(path.slice(CWD.length + 1).replaceAll("\\", "/")),
	});
	return {
		tracker,
		skips,
		/** Work that happens while the next scan is running, after it read the workspace. */
		afterSnapshot,
		scans: () => scans,
		write(path: string): void {
			stamp += 1;
			dirty.set(path, { size: stamp, mtimeMs: stamp, ctimeMs: stamp, ino: 1 });
		},
	};
}

async function settled(window: ReturnType<WrittenFilesTracker["open"]>): Promise<readonly string[] | string> {
	const change = await window.settle();
	return change.kind === "changed" ? change.files.map((file) => file.path) : change.kind;
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
		expect(await flaky.settle()).toEqual({ kind: "unchecked", reason: "over_budget", disabled: false });
		flaky.close();

		const healthy = tracker.open();
		await healthy.ready;
		write("src/a.ts");
		expect(await settled(healthy)).toEqual(["src/a.ts"]);
		healthy.close();

		skips.push("over_budget", "over_budget", "over_budget");
		const slow = tracker.open();
		await slow.ready;
		expect(await slow.settle()).toEqual({ kind: "unchecked", reason: "over_budget", disabled: false });
		slow.close();
		const slowAgain = tracker.open();
		await slowAgain.ready;
		expect(await slowAgain.settle()).toEqual({ kind: "unchecked", reason: "over_budget", disabled: false });
		slowAgain.close();
		const slowThird = tracker.open();
		await slowThird.ready;
		expect(await slowThird.settle()).toEqual({ kind: "unchecked", reason: "over_budget", disabled: true });
		slowThird.close();
		const scansWhenOff = scans();
		const after = tracker.open();
		await after.ready;

		expect(await settled(after)).toBe("off");
		expect(scans()).toBe(scansWhenOff);
	});

	it("turns itself off at once when git is not available", async () => {
		const { tracker, skips } = workspace();
		skips.push("git_unavailable");
		const cell = tracker.open();
		await cell.ready;

		expect(await cell.settle()).toEqual({ kind: "unchecked", reason: "git_unavailable", disabled: true });
	});
});
