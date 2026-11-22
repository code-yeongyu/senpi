import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Retention contract (senpi#3171): a finished bash session stays listed until the 32-session registry
// needs its slot, so every agent session kept up to 31 exited terminals, each with a live headless
// xterm (10,000 lines of scrollback) and its replay history: about 20 MB for a 4,000-line output.
// After exit only the last visible screen is ever read, so that is all an exited session may keep.
// It runs under Bun because the long-lived hosts that grew run on Bun's JSC.
const managerPath = fileURLToPath(new URL("../../../src/core/extensions/builtin/terminal/manager.ts", import.meta.url));

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exited terminal retention", () => {
	it.runIf(process.platform !== "win32")(
		"keeps the final visible screen of a finished session and releases its screen model",
		() => {
			// Given: six finished bash sessions that each printed 4,000 lines.
			const root = mkdtempSync(join(tmpdir(), "senpi-exited-terminal-"));
			roots.push(root);
			const output = execFileSync(
				"bun",
				[
					"--eval",
					`
import { heapStats } from "bun:jsc";
import { TerminalManager } from ${JSON.stringify(managerPath)};
const gc = async () => { for (let i = 0; i < 3; i++) { await new Promise(setImmediate); Bun.gc(true); } return heapStats().heapSize; };
const manager = new TerminalManager();
const warm = await manager.create("true", { command: "/bin/sh", args: ["-c", "true"], cwd: ${JSON.stringify(root)}, cols: 120, rows: 40 });
await new Promise((resolve) => warm.runtime.session.onExit(resolve));
const before = await gc();
const runtimes = [];
for (let i = 0; i < 6; i++) {
	const command = "i=0; while [ $i -lt 4000 ]; do i=$((i+1)); echo \\"row $i of terminal $i zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\\"; done";
	const { runtime } = await manager.create(command, { command: "/bin/sh", args: ["-c", command], cwd: ${JSON.stringify(root)}, cols: 120, rows: 40 });
	await new Promise((resolve) => runtime.session.onExit(resolve));
	runtimes.push(runtime);
}
// When: the sessions have exited and settled, still listed by the manager.
await Promise.all(runtimes.map((runtime) => runtime.screenReleased?.()));
const after = await gc();
const finalScreens = runtimes.map((runtime) => runtime.snapshot().visibleGrid.map((row) => row.trimEnd()).join(""));
console.log(JSON.stringify({ listed: manager.size, perTerminalMB: (after - before) / 6 / 1048576, finalScreens }));
await manager.teardown();
process.exit(0);
`,
				],
				{ cwd: root, encoding: "utf8", timeout: 120_000 },
			);
			const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
				listed: number;
				perTerminalMB: number;
				finalScreens: string[];
			};
			// Then: every session is still listed with its final screen readable, and each one costs
			// about its bounded output text, not a whole screen model.
			expect(result.perTerminalMB).toBeLessThan(3);
			expect(result.listed).toBe(7);
			expect(result.finalScreens).toHaveLength(6);
			for (const screen of result.finalScreens) expect(screen).toMatch(/row 4000 of terminal 4000 z{58}$/);
		},
		180_000,
	);
});
