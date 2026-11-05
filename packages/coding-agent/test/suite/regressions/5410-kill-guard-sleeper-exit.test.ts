// senpi#5410: a kill-guard test sleeper must not outlive its worker. Before the fix,
// `spawnOwnedSleeper` started a detached, unref'd `sleep 300` per suite and only
// `afterAll` stopped it, so a killed worker orphaned the sleeper for up to 5 minutes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnOwnedSleeper } from "../../kill-guard/shim-fixtures.ts";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPidDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return !pidAlive(pid);
}

describe("kill-guard sleeper lifetime (senpi#5410)", () => {
	it("stop() kills the sleeper", async () => {
		const sleeper = spawnOwnedSleeper();
		expect(pidAlive(sleeper.pid)).toBe(true);
		sleeper.stop();
		expect(await waitForPidDeath(sleeper.pid)).toBe(true);
	});

	it("a process that exits without stop() leaves no sleeper behind", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-5410-"));
		try {
			const pidFile = join(root, "sleeper.pid");
			const probe = join(import.meta.dirname, "../../kill-guard/sleeper-exit-probe.ts");
			const result = spawnSync("bun", [probe, pidFile], { encoding: "utf8", timeout: 30_000 });
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(existsSync(pidFile)).toBe(true);
			const pid = Number(readFileSync(pidFile, "utf8"));
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			expect(await waitForPidDeath(pid)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
