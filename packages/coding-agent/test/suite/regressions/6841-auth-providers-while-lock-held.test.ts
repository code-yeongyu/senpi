// senpi#6841: a host (the desktop app's provider card) reads `get_auth_providers`, for example right
// after the machine wakes, while another process holds auth.json's lock for a write. The lock is real:
// a second process holds the store's own proper-lockfile lock, never an injected busy backend.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";

const HOLDER = [
	"const lockfile = require('proper-lockfile');",
	"lockfile.lock(process.argv[1], { realpath: false }).then((release) => {",
	"  process.stdout.write('HELD\\n');",
	"  process.stdin.once('data', () => release().then(() => process.exit(0)));",
	"});",
].join("\n");

async function holdLockFromAnotherProcess(path: string) {
	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["-e", HOLDER, path], { cwd: process.cwd() });
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("the lock holder never held the lock")), 10_000);
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("HELD")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`the lock holder exited ${code}`));
		});
	});
	return () =>
		new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.stdin.end("\n");
		});
}

type Rows = {
	providers: Array<{ id: string; authType: string; status: unknown }>;
	storeError?: unknown;
	storeBusy?: true;
};

describe("senpi#6841 get_auth_providers while another process holds auth.json's lock", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `auth-providers-busy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it(
		"answers within the lock budget while the lock is held, with the stored key and a busy store",
		{ timeout: 120_000 },
		async () => {
			const authJson = join(tempDir, "auth.json");
			writeFileSync(authJson, JSON.stringify({ openai: { type: "api_key", key: "sk-test-6841" } }));
			const release = await holdLockFromAnotherProcess(authJson);
			const harness = makeHarness(tempDir);
			cleanup = harness.cleanup;
			const storage = harness.runtimeHost.session.modelRegistry.authStorage;
			const busyAtStart = storage.isCredentialStoreBusy();
			const collected = makeSink();
			const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
			const read = async (id: string) => {
				await handler.handleInputLine(JSON.stringify({ id, type: "get_auth_providers" }));
				const data = (await collected.waitFor((message) => message.id === id, 10_000)).data as Rows;
				const row = data.providers.find((provider) => provider.id === "openai" && provider.authType === "api_key");
				return { status: row?.status, storeError: data.storeError ?? null, storeBusy: data.storeBusy ?? null };
			};

			const t0 = Date.now();
			const whileHeld = await read("held");
			const heldMs = Date.now() - t0;
			await release();
			const firstAfter = await read("after");

			expect(busyAtStart).toBe(true);
			expect(heldMs).toBeLessThan(3_000);
			expect(whileHeld).toEqual({
				status: { configured: true, source: "stored" },
				storeError: null,
				storeBusy: true,
			});
			expect(firstAfter).toEqual({
				status: { configured: true, source: "stored" },
				storeError: null,
				storeBusy: null,
			});
			await handler.dispose();
		},
	);
	// #6849 review L3: what the read without the lock may and may not do.
	it("keeps the credentials as they were when auth.json does not parse while the lock is held", async () => {
		const authJson = join(tempDir, "auth.json");
		writeFileSync(authJson, "{ not json");
		const release = await holdLockFromAnotherProcess(authJson);
		try {
			const storage = AuthStorage.create(authJson);
			await storage.readWhileBusy();
			expect(storage.isCredentialStoreBusy()).toBe(true);
			expect(storage.get("openai")).toBeUndefined();
		} finally {
			await release();
		}
	}, 120_000);

	it("never writes auth.json back when it reads it without the lock", async () => {
		const authJson = join(tempDir, "auth.json");
		writeFileSync(authJson, JSON.stringify({ openai: { type: "api_key", key: "sk-test-6849" } }));
		const before = readFileSync(authJson);
		const release = await holdLockFromAnotherProcess(authJson);
		try {
			const storage = AuthStorage.create(authJson);
			await storage.readWhileBusy();
			expect(storage.get("openai")).toEqual({ type: "api_key", key: "sk-test-6849" });
			expect(readFileSync(authJson).equals(before)).toBe(true);
		} finally {
			await release();
		}
	}, 120_000);
	// #6849 review L1: a store that loaded but could not save its migrated copy re-reads too; it must
	// wait once per request.
	it("answers within the lock budget for a store with a load error while the lock is held", async () => {
		const authJson = join(tempDir, "auth.json");
		writeFileSync(authJson, JSON.stringify({ "openai-codex": { type: "api_key", key: "sk-test-6849-legacy" } }));
		// The migrated copy is staged at this path, so a directory there makes only the save fail.
		const staging = `${authJson}.${process.pid}.tmp`;
		mkdirSync(staging);
		const harness = makeHarness(tempDir);
		rmSync(staging, { recursive: true });
		cleanup = harness.cleanup;
		const storage = harness.runtimeHost.session.modelRegistry.authStorage;
		expect(storage.getLoadError()?.kind).toBe("write_back_failed");
		expect(storage.isCredentialStoreBusy()).toBe(false);
		const release = await holdLockFromAnotherProcess(authJson);
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		try {
			const started = Date.now();
			await handler.handleInputLine(JSON.stringify({ id: "errored", type: "get_auth_providers" }));
			await collected.waitFor((message) => message.id === "errored", 120_000);
			expect(Date.now() - started).toBeLessThan(3_000);
		} finally {
			await release();
			await handler.dispose();
		}
	}, 180_000);
});
