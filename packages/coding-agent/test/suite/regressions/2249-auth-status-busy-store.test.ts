// omo-desktop-app #2249: the desktop provider card reads `getProviderAuthStatus`, while model
// availability goes through `hasConfiguredAuth`, which re-reads a store that was locked on its
// first read (#2487). After the lock clears, both must agree that the stored credential exists.

import { describe, expect, it } from "vitest";
import { AuthStorage, InMemoryAuthStorageBackend } from "../../../src/core/auth-storage.ts";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";

const PROVIDER = "openai";
const STORED = { [PROVIDER]: { type: "api_key", key: "sk-test-2249" } } as const;

function storeLockedFromStart() {
	const backend = new InMemoryAuthStorageBackend();
	backend.withLock(() => ({ result: undefined, next: JSON.stringify(STORED) }));
	const lock = { held: true };
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

describe("omo-desktop-app #2249 auth status after a busy first credential read", () => {
	it("reports the stored credential as configured once the lock clears, matching model availability", () => {
		const { storage, lock } = storeLockedFromStart();
		const registry = ModelRegistry.inMemory(storage);
		const model = registry.getAll().find((candidate) => candidate.provider === PROVIDER);
		expect(model).toBeDefined();
		if (!model) return;

		lock.held = false;

		expect(registry.hasConfiguredAuth(model)).toBe(true);
		expect(registry.getProviderAuthStatus(PROVIDER)).toEqual({ configured: true, source: "stored" });
	});
});
