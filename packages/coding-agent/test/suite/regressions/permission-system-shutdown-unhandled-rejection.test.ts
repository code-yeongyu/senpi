import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

	it("survives session_shutdown while the permission prompt is open in a strict child process", async () => {
		const fixturePath = fileURLToPath(
			new URL("./fixtures/permission-system-shutdown-unhandled-rejection.mjs", import.meta.url),
		);
		// No tsx startup or source graph: this fixture drives the already-built runtime.
		// Disabling stripping makes an accidental source .ts import fail instead of restoring that cost.
		const child = spawn(process.execPath, ["--no-experimental-strip-types", fixturePath], {
			env: {
				...process.env,
				NODE_OPTIONS: [process.env.NODE_OPTIONS, "--unhandled-rejections=strict"].filter(Boolean).join(" "),
			},
		});
		// Subscribe before any child output. Close also guarantees stderr has drained.
		const closed = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve) => {
			child.once("close", (exitCode, signalCode) => resolve({ exitCode, signalCode }));
		});
		onTestFinished(async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			await closed;
		});
		let spawnError: Error | undefined;
		let stdinError: Error | undefined;
		child.once("error", (error) => {
			spawnError = error;
		});
		child.stdin.once("error", (error) => {
			stdinError = error;
		});
		let stdout = "";
		let stderr = "";
		let promptOpened = false;
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (!promptOpened && stdout.includes("permission prompt open\n")) {
				promptOpened = true;
				child.stdin.end("shutdown\n");
			}
		});

		const result = await closed;
		const diagnostics = JSON.stringify({
			...result,
			spawnError: spawnError?.message,
			stdinError: stdinError?.message,
			stderr,
		});
		expect(spawnError, diagnostics).toBeUndefined();
		expect(stdinError, diagnostics).toBeUndefined();
		expect(result.exitCode, diagnostics).toBe(0);
		expect(result.signalCode, diagnostics).toBeNull();
		expect(promptOpened, diagnostics).toBe(true);
		expect(stdout).toContain("permission shutdown handled");
	});
});
