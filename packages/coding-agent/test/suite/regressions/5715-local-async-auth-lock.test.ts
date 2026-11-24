import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../../../src/core/auth-storage.ts";

it("refuses a sync write without blocking its own async holder, then permits the write after release (#5715)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "senpi-local-lock-"));
	const path = join(dir, "auth.json");
	const backend = new FileAuthStorageBackend(path);
	const writer = AuthStorage.create(path);
	const other = AuthStorage.create(join(dir, "other.json"));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const credential = { type: "oauth", access: "synthetic", refresh: "synthetic", expires: 0 } as const;
	const held = backend.withLockAsync(async () => {
		entered.resolve();
		await release.promise;
		return { result: undefined };
	});
	try {
		await entered.promise;
		const sleep = vi.spyOn(Atomics, "wait").mockImplementation(() => {
			throw new Error("attempted synchronous wait");
		});
		try {
			expect(() => writer.set("fixture", credential)).toThrow(
				expect.objectContaining({ name: "LocalCredentialStoreBusyError", waitedMs: 0 }),
			);
			other.set("fixture", credential);
			expect(sleep).not.toHaveBeenCalled();
		} finally {
			sleep.mockRestore();
		}
		release.resolve();
		await held;
		writer.set("fixture", credential);
		expect(writer.get("fixture")).toMatchObject({ type: "oauth" });
	} finally {
		release.resolve();
		await held;
		rmSync(dir, { recursive: true, force: true });
	}
});
