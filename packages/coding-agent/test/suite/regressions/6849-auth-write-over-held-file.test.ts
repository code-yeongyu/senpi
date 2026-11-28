// senpi#6849 review L4: on Windows a rename over a file another process holds open fails with
// EPERM until that handle closes. A credential write must wait that out within the lock budget.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthStorage, FileAuthStorageBackend } from "../../../src/core/auth-storage.ts";

// The held file is simulated at the backend's own write step: its first attempt fails the way a Windows
// rename over an open handle does, later attempts write for real.
type Writer = { writeAuthFile: (content: string) => void };
const backendWriter = FileAuthStorageBackend.prototype as unknown as Writer;

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
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("lands a credential update once the holder lets go of the file", async () => {
		const authJson = join(dir, "auth.json");
		writeFileSync(authJson, JSON.stringify({ openai: { type: "api_key", key: "sk-before" } }));
		const write = vi.spyOn(backendWriter, "writeAuthFile").mockImplementationOnce(() => {
			throw heldOpen();
		});
		const storage = AuthStorage.create(authJson);

		await storage.modify("openai", async () => ({ type: "api_key", key: "sk-after" }));

		expect(JSON.parse(readFileSync(authJson, "utf8")).openai).toEqual({ type: "api_key", key: "sk-after" });
		expect(write.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("reports contention to a synchronous writer without retrying or changing the file (#6860)", () => {
		const authJson = join(dir, "auth.json");
		writeFileSync(authJson, "{}");
		const storage = AuthStorage.create(authJson);
		const cause = Object.assign(heldOpen(), { syscall: "rename", dest: authJson });
		const write = vi.spyOn(backendWriter, "writeAuthFile").mockImplementationOnce(() => {
			throw cause;
		});
		expect(() => storage.set("example", { type: "api_key", key: "fixture" })).toThrow(
			expect.objectContaining({ message: expect.stringMatching(/auth\.json.*in use/i), code: "EPERM", cause }),
		);
		expect(write).toHaveBeenCalledTimes(1);
		expect(readFileSync(authJson, "utf8")).toBe("{}");
		// The caller can retry after the reader releases its handle; the failed writer released its lock.
		storage.set("example", { type: "api_key", key: "fixture" });
		expect(readFileSync(authJson, "utf8")).toContain("fixture");
	});

	it("keeps the original diagnostic when staging the new credential file is denied", () => {
		const authJson = join(dir, "auth.json");
		writeFileSync(authJson, "{}");
		const storage = AuthStorage.create(authJson);
		const denied = Object.assign(new Error("staging directory is read-only"), { code: "EACCES", syscall: "open" });
		vi.spyOn(backendWriter, "writeAuthFile").mockImplementationOnce(() => {
			throw denied;
		});
		expect(() => storage.set("example", { type: "api_key", key: "fixture" })).toThrow(denied);
	});
	// #6849 review L5: the lock can be lost while the write waits; nothing may be written after that.
	it("writes nothing once the lock is lost during the wait", async () => {
		const authJson = join(dir, "auth.json");
		const before = JSON.stringify({ openai: { type: "api_key", key: "sk-before" } });
		writeFileSync(authJson, before);
		const backendPrototype = Object.getPrototypeOf(
			(AuthStorage.create(authJson) as unknown as { storage: object }).storage,
		) as {
			acquireLockAsync: (signal: AbortSignal | undefined, onCompromised: (error: Error) => void) => Promise<unknown>;
		};
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
		vi.spyOn(backendWriter, "writeAuthFile").mockImplementationOnce(() => {
			loseLock();
			throw heldOpen();
		});
		const storage = AuthStorage.create(authJson);

		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "sk-after" }))).rejects.toThrow(
			"lock compromised",
		);

		expect(readFileSync(authJson, "utf8")).toBe(before);
		spy.mockRestore();
	});
});
