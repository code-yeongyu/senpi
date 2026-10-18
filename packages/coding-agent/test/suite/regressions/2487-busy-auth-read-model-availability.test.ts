// #2487: a credential read that finds auth.json locked must not become the process's model
// availability. A busy first availability pass must not publish an empty snapshot as
// "initialized". Only a busy read is retried: a readable empty store stays cached.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, InMemoryAuthStorageBackend } from "../../../src/core/auth-storage.ts";
import { brandEnvNames } from "../../../src/core/brand.ts";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

const PROVIDER = "openai";
const STORED = { [PROVIDER]: { type: "api_key", key: "sk-test-2487" } } as const;

let agentDir: string;
let authPath: string;

/** Hold the store lock exactly the way proper-lockfile does: a fresh `<file>.lock` directory. */
function holdAuthLock(): () => void {
	mkdirSync(`${authPath}.lock`);
	return () => rmSync(`${authPath}.lock`, { recursive: true, force: true });
}

function lockableStore(initial: object, options: { heldFromStart?: boolean } = {}) {
	const backend = new InMemoryAuthStorageBackend();
	backend.withLock(() => ({ result: undefined, next: JSON.stringify(initial) }));
	const lock = { held: options.heldFromStart === true };
	const busy = () => new CredentialStoreBusyError("auth.json", 1_000);
	const storage = AuthStorage.fromStorage({
		withLock: (fn) => {
			if (lock.held) throw busy();
			return backend.withLock(fn);
		},
		withLockAsync: async (fn, options) => {
			if (lock.held) throw busy();
			return backend.withLockAsync(fn, options);
		},
	});
	return { storage, lock };
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "senpi-2487-"));
	authPath = join(agentDir, "auth.json");
	for (const name of brandEnvNames("CODING_AGENT_DIR")) vi.stubEnv(name, agentDir);
	vi.stubEnv("OPENAI_API_KEY", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("busy credential reads never become model availability (#2487)", () => {
	it("a busy availability pass stays uninitialized and the next pass publishes the full list", async () => {
		// Given: a fresh process whose store has been locked since it opened.
		const { storage, lock } = lockableStore(STORED, { heldFromStart: true });
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, refreshOnCreate: false });

		// When: availability is refreshed under the lock, then again after it is released.
		const whileLocked = await runtime.getAvailable();
		const busyState = {
			initialized: runtime.hasAvailabilitySnapshot(),
			fresh: runtime.hasFreshAvailabilitySnapshot(),
		};
		lock.held = false;
		const afterRelease = await runtime.getAvailable();

		// Then: the busy pass published nothing; the next one carries the stored provider.
		expect(whileLocked.filter((model) => model.provider === PROVIDER)).toEqual([]);
		expect(busyState).toEqual({ initialized: false, fresh: false });
		expect(afterRelease.filter((model) => model.provider === PROVIDER).length).toBeGreaterThan(0);
		expect(runtime.hasFreshAvailabilitySnapshot()).toBe(true);
		expect(runtime.getAvailableSnapshot()).toEqual(afterRelease);
	});

	it("a busy read after a successful load keeps serving the last loaded credentials", async () => {
		// Given: a store that loaded its credentials before another process took the lock.
		const { storage, lock } = lockableStore(STORED);
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, refreshOnCreate: false });
		lock.held = true;

		// When: availability is refreshed while the lock is held.
		const available = await runtime.getAvailable();

		// Then: the last loaded credentials are a real answer, not a busy placeholder.
		expect(available.filter((model) => model.provider === PROVIDER).length).toBeGreaterThan(0);
		expect(runtime.hasFreshAvailabilitySnapshot()).toBe(true);
		expect(storage.isCredentialStoreBusy()).toBe(false);
	});
});

describe("a readable empty store stays cached (#2487)", () => {
	it("model availability from an empty store is not re-read on every call", () => {
		// Given: a readable auth.json with no credentials, already listed once.
		writeFileSync(authPath, "{}");
		const storage = AuthStorage.create(authPath);
		const registry = ModelRegistry.create(storage, join(agentDir, "models.json"));
		const first = registry.getAvailable();

		// When: the store is locked and the list is requested again.
		const release = holdAuthLock();
		let second: ReturnType<ModelRegistry["getAvailable"]>;
		try {
			second = registry.getAvailable();
		} finally {
			release();
		}

		// Then: the cached empty answer is reused without touching the lock.
		expect(first.filter((model) => model.provider === PROVIDER)).toEqual([]);
		expect(second).toEqual(first);
		expect(storage.isCredentialStoreBusy()).toBe(false);
		expect(storage.drainErrors()).toEqual([]);
	});

	it("an empty store initializes availability and later passes reuse it without the lock", async () => {
		// Given: a runtime over a readable empty auth.json whose first pass succeeded.
		writeFileSync(authPath, "{}");
		const storage = AuthStorage.create(authPath);
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null, refreshOnCreate: false });
		const first = await runtime.getAvailable();

		// When: the store is locked and availability is refreshed again.
		const release = holdAuthLock();
		let second: readonly unknown[];
		try {
			second = await runtime.getAvailable();
		} finally {
			release();
		}

		// Then: the empty result counts as a real answer and is served from cache.
		expect(second).toEqual(first);
		expect(runtime.hasFreshAvailabilitySnapshot()).toBe(true);
		expect(storage.getBusyReadCount()).toBe(0);
		expect(storage.drainErrors()).toEqual([]);
	});
});
