// #2487: a load that repairs or migrates auth.json rewrites the file and leaves the shared read
// state's revision unset, so the next store cannot skip its startup read. When that read finds
// the store locked, the new store must still start from the shared credentials (not an empty
// busy placeholder) and must still have attempted the read. Like its sibling, this must be the
// first store opened in its module graph, which is why it lives in its own file.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_PROVIDER_IDS } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";

const [LEGACY_ID, CANONICAL_ID] = Object.entries(LEGACY_PROVIDER_IDS)[0] ?? [];

let agentDir: string;
let authPath: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "senpi-2487-migrated-"));
	authPath = join(agentDir, "auth.json");
	vi.stubEnv("OPENAI_API_KEY", undefined);
	vi.stubEnv("ANTHROPIC_API_KEY", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

it("a store opened after a migrated load keeps the shared credentials when its startup read is busy", () => {
	// Given: the first store migrated a legacy provider key, rewriting auth.json.
	expect(LEGACY_ID).toBeDefined();
	writeFileSync(
		authPath,
		JSON.stringify({
			openai: { type: "api_key", key: "sk-test-2487" },
			[String(LEGACY_ID)]: { type: "api_key", key: "sk-test-2487-legacy" },
		}),
	);
	const first = AuthStorage.create(authPath);
	expect(first.has(String(CANONICAL_ID))).toBe(true);
	expect(Object.keys(JSON.parse(readFileSync(authPath, "utf8")))).not.toContain(LEGACY_ID);

	// When: a second store opens the same file while another process holds the lock.
	mkdirSync(`${authPath}.lock`);
	let second: AuthStorage;
	try {
		second = AuthStorage.create(authPath);
	} finally {
		rmSync(`${authPath}.lock`, { recursive: true, force: true });
	}

	// Then: it tried the read, found it busy, and still serves the shared credentials.
	expect(second.drainErrors().some((error) => error instanceof CredentialStoreBusyError)).toBe(true);
	expect(second.isCredentialStoreBusy()).toBe(false);
	expect(second.has("openai")).toBe(true);
	expect(second.has(String(CANONICAL_ID))).toBe(true);
	const available = ModelRegistry.create(second, join(agentDir, "models.json")).getAvailable();
	expect(available.filter((model) => model.provider === "openai").length).toBeGreaterThan(0);

	// And: once the lock is gone, its next read picks up what changed meanwhile.
	const stored = JSON.parse(readFileSync(authPath, "utf8"));
	writeFileSync(authPath, JSON.stringify({ ...stored, anthropic: { type: "api_key", key: "sk-test-2487-a" } }));
	expect(second.reload()).toBe("loaded");
	expect(second.has("anthropic")).toBe(true);
	expect(second.has("openai")).toBe(true);
});
