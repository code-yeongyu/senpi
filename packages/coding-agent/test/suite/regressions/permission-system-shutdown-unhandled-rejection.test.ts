import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { PermissionService } from "../../../src/core/extensions/builtin/permission-system/service.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "../../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../../utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const tempDir of tempDirs.splice(0)) {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	}
});

describe("permission system shutdown unhandled rejection", () => {
	it.each([undefined, null, false, 0, ""])("blocks a permission request rejected with %j", async (reason) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-perm-falsy-rejection-"));
		tempDirs.push(tempDir);
		const extensionsResult = await createTestExtensionsResult([permissionSystemExtension], tempDir);
		const sessionManager = SessionManager.create(tempDir);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir,
			sessionManager,
			modelRegistry,
			extensionsResult.eventBus,
		);

		runner.setFlagValue("permission-preset", "ask");
		await runner.emit({ type: "session_start", reason: "startup" });
		vi.spyOn(PermissionService.prototype, "ask").mockRejectedValueOnce(reason);

		const result = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			input: { command: "echo hello" },
			toolCallId: "call-1",
		});

		expect(result).toEqual({ block: true, reason: "Permission request was rejected." });
	});

	it("survives session_shutdown while the permission prompt is open in a strict child process", () => {
		const fixturePath = fileURLToPath(
			new URL("./fixtures/permission-system-shutdown-unhandled-rejection.ts", import.meta.url),
		);
		const result = spawnSync(process.execPath, ["--import", "tsx", fixturePath], {
			encoding: "utf8",
			env: {
				...process.env,
				NODE_OPTIONS: [process.env.NODE_OPTIONS, "--unhandled-rejections=strict"].filter(Boolean).join(" "),
			},
			timeout: 30_000,
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("permission shutdown handled");
	});
});
