import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

const lockState = vi.hoisted(() => ({
	attempts: 0,
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

describe("FileAuthStorageBackend lock-retry CPU spin", () => {
	let root: string;
	let authPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "senpi-authspin-"));
		authPath = join(root, "auth.json");
		mkdirSync(root, { recursive: true });
		writeFileSync(authPath, "{}", "utf-8");
		lockState.attempts = 0;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("#given a contended auth lock #when a sync write waits through 9 retries #then user CPU stays a small fraction of wall time (no busy-wait spin)", () => {
		const backend = new FileAuthStorageBackend(authPath);
		const cpuBefore = process.cpuUsage();
		const wallBefore = Date.now();
		backend.withLock((current) => ({ result: undefined, next: current ?? "{}" }));
		const cpuAfter = process.cpuUsage();
		const wallMs = Date.now() - wallBefore;
		const userMs = (cpuAfter.user - cpuBefore.user) / 1000;

		// 9 retries x 20ms = ~180ms wall must elapse (retry path ran), but a real
		// sleep keeps user CPU near zero while a busy-wait spin makes it ~= wall.
		expect(wallMs).toBeGreaterThan(100);
		expect(userMs).toBeLessThan(80);
	});
});
