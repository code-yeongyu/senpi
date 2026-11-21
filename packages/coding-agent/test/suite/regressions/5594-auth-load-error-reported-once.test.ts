/**
 * senpi#5594 review: startup awaits an async settle of the auth store before it takes notices, so a store that is
 * broken or locked must still be reported once per startup, not once by the synchronous first load and again by the
 * async read. Every file is a temp file; the lock is held by this test.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { FILE_STORAGE_LOCK_OPTIONS } from "../../../src/core/lockfile-policy.ts";
import { collectAuthDiagnostics, interactiveAuthNotices } from "../../../src/main.ts";

const LOCK_WAIT_MS = 30_000;

describe("senpi#5594 a broken or locked auth store is reported once per startup", () => {
	let dir: string;
	let authPath: string;
	let release: (() => void) | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-5594-load-error-"));
		authPath = join(dir, "auth.json");
		writeFileSync(authPath, "{ not json", { mode: 0o600 });
	});
	afterEach(() => {
		release?.();
		release = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	const holdLock = () => {
		writeFileSync(authPath, "{}", { mode: 0o600 });
		release = lockfile.lockSync(authPath, { ...FILE_STORAGE_LOCK_OPTIONS, retries: 0 });
	};

	it("an interactive start shows a corrupt auth.json once", async () => {
		const notices = await interactiveAuthNotices(AuthStorage.create(authPath));

		expect(notices.messages).toHaveLength(1);
	});

	it("a print or RPC start reports a corrupt auth.json once", async () => {
		const diagnostics = await collectAuthDiagnostics(AuthStorage.create(authPath), "runtime creation", {
			persistSeen: false,
		});

		expect(diagnostics).toHaveLength(1);
	});

	it(
		"an interactive start shows a held lock once",
		async () => {
			holdLock();

			const notices = await interactiveAuthNotices(AuthStorage.create(authPath));

			expect(notices.messages).toHaveLength(1);
		},
		LOCK_WAIT_MS,
	);

	it(
		"a print or RPC start reports a held lock once",
		async () => {
			holdLock();

			const diagnostics = await collectAuthDiagnostics(AuthStorage.create(authPath), "runtime creation", {
				persistSeen: false,
			});

			expect(diagnostics).toHaveLength(1);
		},
		LOCK_WAIT_MS,
	);

	it("an async read of a store the first load already found broken does not record the failure again", async () => {
		const storage = AuthStorage.create(authPath);

		await storage.read("anthropic-subscription");

		expect(storage.drainErrors()).toHaveLength(1);
	});
});
