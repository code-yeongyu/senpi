import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthOperationOptions } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../../../src/core/auth-storage.ts";
import { operationSignal } from "../../../src/utils/abort.ts";

class AsyncReadLockFailureBackend implements AuthStorageBackend {
	private readonly initial: string;
	private readonly failure: Error;

	constructor(initial: string, failure: Error) {
		this.initial = initial;
		this.failure = failure;
	}

	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
		return fn(this.initial).result;
	}

	async withLockAsync<T>(
		_fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		_options?: AuthOperationOptions,
	): Promise<T> {
		throw this.failure;
	}
}

class CorruptAsyncReadBackend implements AuthStorageBackend {
	private readonly initial: string;

	constructor(initial: string) {
		this.initial = initial;
	}

	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
		return fn(this.initial).result;
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<{ result: T; next?: string }>,
		_options?: AuthOperationOptions,
	): Promise<T> {
		return (await fn("{invalid-json")).result;
	}
}

describe("auth read lock degradation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns last-good file credentials and records EPERM when the async lock cannot be acquired", async () => {
		const directory = mkdtempSync(join(tmpdir(), "senpi-auth-lock-degrade-"));
		const authPath = join(directory, "auth.json");
		const failure = Object.assign(new Error(`operation not permitted, mkdir '${authPath}.lock'`), {
			code: "EPERM",
		});
		try {
			writeFileSync(authPath, JSON.stringify({ mock: { type: "api_key", key: "last-good-key" } }));
			const storage = AuthStorage.create(authPath);
			writeFileSync(
				authPath,
				JSON.stringify({
					mock: { type: "api_key", key: "new-key" },
					other: { type: "api_key", key: "force-a-new-file-revision" },
				}),
			);
			vi.spyOn(lockfile, "lock").mockRejectedValue(failure);

			await expect(storage.read("mock", { signal: operationSignal() })).resolves.toEqual({
				type: "api_key",
				key: "last-good-key",
			});
			expect(storage.drainErrors()).toEqual([failure]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("returns last-good credentials and records EPERM for an injected async storage failure", async () => {
		const failure = Object.assign(new Error("operation not permitted, mkdir '/sandbox/auth.json.lock'"), {
			code: "EPERM",
		});
		const storage = AuthStorage.fromStorage(
			new AsyncReadLockFailureBackend(JSON.stringify({ mock: { type: "api_key", key: "last-good-key" } }), failure),
		);

		await expect(storage.read("mock", { signal: operationSignal() })).resolves.toEqual({
			type: "api_key",
			key: "last-good-key",
		});
		expect(storage.drainErrors()).toEqual([failure]);
		expect(storage.drainErrors()).toEqual([]);
	});

	test("returns last-good credentials but records a corrupt async auth read", async () => {
		const storage = AuthStorage.fromStorage(
			new CorruptAsyncReadBackend(JSON.stringify({ mock: { type: "api_key", key: "last-good-key" } })),
		);

		await expect(storage.read("mock", { signal: operationSignal() })).resolves.toEqual({
			type: "api_key",
			key: "last-good-key",
		});
		expect(storage.drainErrors()).toEqual([expect.any(SyntaxError)]);
	});
});
