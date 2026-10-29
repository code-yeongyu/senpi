import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import { sharedPathIdentityResolver } from "../../src/core/extensions/builtin/permission-system/path-identity-host.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionError } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const originalAgentDir = process.env[ENV_AGENT_DIR];
const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session_shutdown releases the resolver subscription on the error path", () => {
	it("releases it when persisting the session's answers throws", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "senpi-perm-shutdown-release-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		const resolver = sharedPathIdentityResolver();
		const baseline = resolver.listenerCount;

		const extensionsResult = await createTestExtensionsResult([permissionSystemExtension], tempDir);
		const runner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir,
			SessionManager.create(tempDir),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
			extensionsResult.eventBus,
		);
		const errors: ExtensionError[] = [];
		runner.onError((error) => errors.push(error));
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(resolver.listenerCount).toBe(baseline + 1);

		// The approvals store cannot be created: its parent path is a regular file, so appendApproved's mkdir throws.
		writeFileSync(join(agentDir, "permissions"), "");
		vi.spyOn(PermissionService.prototype, "getSessionApproved").mockReturnValue([
			{ permission: "bash", pattern: "echo *", action: "allow" },
		]);

		await runner.emit({ type: "session_shutdown", reason: "quit" });

		const shutdownErrors = errors.filter((error) => error.event === "session_shutdown");
		expect(shutdownErrors.map((error) => error.error)).toEqual([expect.stringMatching(/ENOTDIR|EEXIST/)]);
		expect(resolver.listenerCount).toBe(baseline);
	});
});
