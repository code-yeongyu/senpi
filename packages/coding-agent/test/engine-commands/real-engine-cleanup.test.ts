import { mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type RealEngineRun, realEngine, runsStillAlive } from "./real-engine.ts";

// A real entry that wrongly starts a mode never exits, and the test that started it gives up on it: realEngine ends its
// own child when that test finishes, so no run outlives its test. Proved by pid with an entry that never exits.

const root = realpathSync(mkdtempSync(join(tmpdir(), "real-engine-cleanup-")));
afterAll(() => {
	expect(runsStillAlive()).toEqual([]);
	rmSync(root, { recursive: true, force: true });
});
const neverExits = join(root, "never-exits.ts");
writeFileSync(
	neverExits,
	'require("node:fs").writeFileSync("pid", String(process.pid));\nsetInterval(() => {}, 1 << 30);\n',
);

function pidWritten(): Promise<number> {
	return new Promise((written) => {
		const watcher = watch(root, (_event, name) => {
			if (name !== "pid") return;
			const text = readFileSync(join(root, "pid"), "utf8");
			if (text === "") return;
			watcher.close();
			written(Number(text));
		});
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("realEngine ends its own child when the test that started it finishes", () => {
	let pid = 0;
	let run: Promise<RealEngineRun> | undefined;

	it("starts a run that never answers and finishes without waiting for it", async () => {
		const written = pidWritten();
		run = realEngine([], { root, table: undefined, entry: neverExits });
		pid = await written;
		expect(alive(pid)).toBe(true);
	});

	it("the run ended with its test: the child is gone, by pid", async () => {
		expect(run).toBeDefined();
		const ended = await run;
		expect(ended?.code).toBeNull();
		expect(alive(pid)).toBe(false);
	});
});
