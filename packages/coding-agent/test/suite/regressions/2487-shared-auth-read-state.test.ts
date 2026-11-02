// #2487: the first auth.json path a process opens shares one read state across stores. A second
// store opened on the unchanged file skipped its read and started from an empty snapshot, so a
// lazily built model/list registry answered with no models. This must be the first store opened
// in its module graph, which is why it lives in its own file.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "senpi-2487-shared-"));
	vi.stubEnv("OPENAI_API_KEY", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

it("a second store opened on an already-loaded auth.json sees its credentials", () => {
	// Given: one store has already loaded auth.json in this process.
	const authPath = join(agentDir, "auth.json");
	writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "sk-test-2487" } }));
	AuthStorage.create(authPath);

	// When: a second store opens the same, unchanged file and lists models through it.
	const second = AuthStorage.create(authPath);
	const available = ModelRegistry.create(second, join(agentDir, "models.json")).getAvailable();

	// Then: it adopts the loaded credentials instead of starting empty.
	expect(second.has("openai")).toBe(true);
	expect(available.filter((model) => model.provider === "openai").length).toBeGreaterThan(0);
});
