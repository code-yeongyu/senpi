import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { goalFilePath } from "../../src/core/extensions/builtin/goal/persistence.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import { createExtensionRuntime } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";

describe("session goal-store context (#1663)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "senpi-goal-context-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it.each(["persisted", "sessionDir override", "in-memory"])(
		"resolves the authoritative goal-store path for a %s session without creating it",
		async (mode) => {
			let sessionManager = SessionManager.create(cwd, join(cwd, "sessions"), { id: "goal-context" });
			if (mode === "sessionDir override") {
				const path = join(cwd, "original.jsonl");
				writeFileSync(
					path,
					`${JSON.stringify({ type: "session", version: 3, id: "goal-context", timestamp: new Date(0).toISOString(), cwd })}\n`,
				);
				sessionManager = SessionManager.open(path, join(cwd, "other-sessions"));
			} else if (mode === "in-memory") {
				sessionManager = SessionManager.inMemory(cwd, { id: "goal-context" });
			}
			const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
			const runner = new ExtensionRunner([], createExtensionRuntime(), cwd, sessionManager, registry);
			const ctx = runner.createContext();
			const expected = goalFilePath(goalStoreRef(sessionManager, cwd));
			expect(ctx.goalStoreFile).toBe(expected);
			expect(Object.getOwnPropertyDescriptor(ctx, "goalStoreFile")?.get).toBeTypeOf("function");
			if (mode === "in-memory") {
				const bucket = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
				expect(expected).toBe(join(getAgentDir(), "extensions", "goal", "no-session", bucket, "goal-context.json"));
			} else {
				const sessionDir = join(cwd, mode === "persisted" ? "sessions" : "other-sessions");
				expect(expected).toBe(join(sessionDir, "extensions", "goal", "goal-context.json"));
			}
			expect(existsSync(expected)).toBe(false);
		},
	);
});
