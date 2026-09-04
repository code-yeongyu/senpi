import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import {
	FILE_STORAGE_LOCK_RETRY_BUDGET_MS,
	FILE_STORAGE_SYNC_LOCK_BUDGET_MS,
} from "../src/core/lockfile-policy.ts";
import { FileSettingsStorage } from "../src/core/settings-manager.ts";

type CapturedLockOptions = Record<string, unknown>;

describe("file storage lock policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("auth sync, auth async, and settings sync locks share one stale/update policy", async () => {
		// #given a sync contender using proper-lockfile's default stale window can declare a live
		// async lock stale mid-update, so every file-backed store must acquire with one policy.
		const directory = mkdtempSync(join(tmpdir(), "senpi-lockfile-policy-"));
		const authPath = join(directory, "auth.json");
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}");

		const syncOptions: CapturedLockOptions[] = [];
		const asyncOptions: CapturedLockOptions[] = [];
		vi.spyOn(lockfile, "lockSync").mockImplementation(((_file: string, options?: CapturedLockOptions) => {
			syncOptions.push(options ?? {});
			return () => {};
		}) as typeof lockfile.lockSync);
		vi.spyOn(lockfile, "lock").mockImplementation(((_file: string, options?: CapturedLockOptions) => {
			asyncOptions.push(options ?? {});
			return Promise.resolve(() => Promise.resolve());
		}) as typeof lockfile.lock);

		try {
			// #when
			const authBackend = new FileAuthStorageBackend(authPath);
			authBackend.withLock((current) => ({ result: current }));
			await authBackend.withLockAsync(async (current) => ({ result: current }));
			// Reads are lock-free since the atomic temp+rename publish, so the settings
			// lock policy is observable only through a write-returning callback.
			new FileSettingsStorage(directory, agentDir).withLock("global", () => "{}");

			// #then
			expect(syncOptions).toHaveLength(2);
			expect(asyncOptions).toHaveLength(1);
			const policies = [...syncOptions, ...asyncOptions].map((options) => ({
				stale: options.stale,
				update: options.update,
				realpath: options.realpath,
				retries: options.retries,
			}));
			expect(policies[0]).toMatchObject({ stale: 30_000, update: 10_000, realpath: false, retries: 0 });
			expect(policies[1]).toMatchObject({ stale: 30_000, update: 10_000, realpath: false, retries: 0 });
			// Every store acquires with retries: 0 and owns its own bounded wait loop, so an
			// AbortSignal is observed between attempts instead of after the whole budget.
			expect(policies[2]).toMatchObject({ stale: 30_000, update: 10_000, realpath: false, retries: 0 });
			expect(FILE_STORAGE_LOCK_RETRY_BUDGET_MS).toBe(5_500);
			expect(FILE_STORAGE_SYNC_LOCK_BUDGET_MS).toBe(1_000);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
