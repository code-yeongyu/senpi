import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage, getSettingsPath } from "../src/core/settings-manager.ts";

const lockState = vi.hoisted(() => ({
	attempts: 0,
	// Throw ELOCKED for attempts 1..9, succeed on the 10th => 9x ~20ms waits.
	succeedOnAttempt: 10,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof import("proper-lockfile") }>();
	const base = actual.default;
	return {
		default: {
			...base,
			lockSync: (_path: string, _opts?: Parameters<typeof base.lockSync>[1]) => {
				lockState.attempts += 1;
				if (lockState.attempts < lockState.succeedOnAttempt) {
					throw Object.assign(new Error("LOCKED"), { code: "ELOCKED" });
				}
				return () => {};
			},
		},
	};
});

describe("FileSettingsStorage lock-retry CPU spin", () => {
	let root: string;
	let cwd: string;
	let settingsPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "senpi-cpuspin-"));
		const agentDir = join(root, "agent");
		cwd = join(root, "work");
		settingsPath = getSettingsPath(cwd, agentDir, "global", root);
		mkdirSync(join(root, "agent"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ x: 1 }), "utf-8");
		lockState.attempts = 0;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("#given a contended lock #when withLock waits through 9 retries #then user CPU stays a small fraction of wall time (no busy-wait spin)", () => {
		const storage = new FileSettingsStorage(cwd, join(root, "agent"), root);
		const cpuBefore = process.cpuUsage();
		const wallBefore = Date.now();
		// Reads are lock-free since the atomic temp+rename publish; only a WRITE
		// acquires the settings lock, so contention is exercised through one.
		storage.withLock("global", (current) => {
			expect(current).toBeDefined();
			return JSON.stringify({ x: 2 });
		});
		const cpuAfter = process.cpuUsage();
		const wallMs = Date.now() - wallBefore;
		const userMs = (cpuAfter.user - cpuBefore.user) / 1000;

		// 9 retries x 20ms = ~180ms wall. The wait MUST happen (proves the retry
		// path ran) but CPU must NOT burn near wall-clock (a busy-wait spin does).
		// A real sleep keeps user CPU near zero; a spin makes it ~= wall time.
		expect(wallMs).toBeGreaterThan(100);
		expect(userMs).toBeLessThan(80);
	});
});
