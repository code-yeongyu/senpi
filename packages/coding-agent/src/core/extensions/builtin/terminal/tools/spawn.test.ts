import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../manager.ts";
import { spawnCommandSession } from "./spawn.ts";

// senpi#7061: a gated command runs only once the barrier admits it; a refused launch never runs and its session is stopped.
describe.skipIf(process.platform === "win32")("spawnCommandSession behind a launch barrier", () => {
	const manager = new TerminalManager();
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "spawn-barrier-"));
	});
	afterEach(async () => {
		await manager.teardown();
		rmSync(dir, { recursive: true, force: true });
	});

	it("a refused launch stops the gated shell before the command runs", async () => {
		const marker = join(dir, "ran");
		let created: number | undefined;
		const spawned = spawnCommandSession(
			{
				manager,
				cwd: dir,
				defaultCols: 80,
				defaultRows: 24,
				getEnv: () => ({ ...process.env }),
				launchBarrier: {
					admit: async (session) => {
						created = session.pid;
						throw new Error("launch refused");
					},
				},
			},
			{ command: `touch '${marker}'`, cols: 80, rows: 24 },
		);

		await expect(spawned).rejects.toThrow("launch refused");
		expect(created).toBeTypeOf("number");
		expect(manager.list().map(({ runtime }) => runtime.exited)).toEqual([true]);
		expect(existsSync(marker)).toBe(false);
	});
});
