// senpi#6849 review L4: on Windows a rename over a file another process holds open fails with
// EPERM until that handle closes. A credential write must wait that out within the lock budget.
import * as fs from "fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const { AuthStorage } = await import("../../../src/core/auth-storage.ts");

const heldOpen = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

describe("senpi#6849 a credential write while another process holds auth.json open (Windows)", () => {
	const platform = process.platform;
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `auth-held-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		Object.defineProperty(process, "platform", { value: "win32" });
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: platform });
		vi.mocked(fs.renameSync).mockReset();
		rmSync(dir, { recursive: true, force: true });
	});

	it("lands a credential update once the holder lets go of the file", async () => {
		const authJson = join(dir, "auth.json");
		writeFileSync(authJson, JSON.stringify({ openai: { type: "api_key", key: "sk-before" } }));
		const actual = await vi.importActual<typeof import("fs")>("fs");
		vi.mocked(fs.renameSync)
			.mockImplementationOnce(() => {
				throw heldOpen();
			})
			.mockImplementation(actual.renameSync);
		const storage = AuthStorage.create(authJson);

		await storage.modify("openai", async () => ({ type: "api_key", key: "sk-after" }));

		expect(JSON.parse(readFileSync(authJson, "utf8")).openai).toEqual({ type: "api_key", key: "sk-after" });
		expect(vi.mocked(fs.renameSync).mock.calls.length).toBeGreaterThanOrEqual(2);
	});
	// #6849 review L5: the lock can be lost while the write waits; nothing may be written after that.
	it("writes nothing once the lock is lost during the wait", async () => {
		const authJson = join(dir, "auth.json");
		const before = JSON.stringify({ openai: { type: "api_key", key: "sk-before" } });
		writeFileSync(authJson, before);
		const backendPrototype = Object.getPrototypeOf(
			(AuthStorage.create(authJson) as unknown as { storage: object }).storage,
		) as { acquireLockAsync: (signal: AbortSignal | undefined, onCompromised: (error: Error) => void) => Promise<unknown> };
		const acquire = backendPrototype.acquireLockAsync;
		let loseLock = () => {};
		const spy = vi.spyOn(backendPrototype, "acquireLockAsync").mockImplementation(function (
			this: unknown,
			signal: AbortSignal | undefined,
			onCompromised: (error: Error) => void,
		) {
			loseLock = () => onCompromised(new Error("lock compromised"));
			return acquire.call(this, signal, onCompromised);
		});
		const actual = await vi.importActual<typeof import("fs")>("fs");
		vi.mocked(fs.renameSync)
			.mockImplementationOnce(() => {
				loseLock();
				throw heldOpen();
			})
			.mockImplementation(actual.renameSync);
		const storage = AuthStorage.create(authJson);

		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "sk-after" }))).rejects.toThrow(
			"lock compromised",
		);

		expect(readFileSync(authJson, "utf8")).toBe(before);
		spy.mockRestore();
	});
});
