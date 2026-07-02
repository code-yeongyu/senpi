import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandHook, selectCommandForPlatform } from "../../src/core/extensions/builtin/hooks/command-runner.ts";
import type {
	ExecutableHookHandler,
	HookInputWire,
	HookSourceMetadata,
} from "../../src/core/extensions/builtin/hooks/types.ts";

const SOURCE: HookSourceMetadata = {
	discoveredAt: "pre-session",
	displayOrder: 1,
	scope: "project",
	sourcePath: "/repo/.senpi/hooks.json",
};
const tempDirs: string[] = [];

function createHandler(command: string, options?: { readonly timeout?: number }): ExecutableHookHandler {
	return {
		config: {
			type: "command",
			command,
			...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
		},
		event: "PreToolUse",
		groupIndex: 0,
		handlerIndex: 0,
		source: SOURCE,
	};
}

function createWindowsHandler(command: string, commandWindows: string): ExecutableHookHandler {
	return {
		...createHandler(command),
		config: {
			type: "command",
			command,
			commandWindows,
		},
	};
}

function createTempDir(name: string): string {
	const dir = join(realpathSync(tmpdir()), `senpi-hooks-${name}-${process.pid}-${Date.now()}`);
	tempDirs.push(dir);
	return dir;
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
			throw error;
		}
		await delay(10);
	}
	throw new Error(`process ${pid} is still running`);
}

describe("builtin hooks command runner", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("writes JSON stdin, runs in cwd, and captures stdout stderr and exit metadata", async () => {
		// Given
		const cwd = createTempDir("json-stdin");
		mkdirSync(cwd, { recursive: true });
		const scriptPath = join(cwd, "echo-hook.mjs");
		writeFileSync(
			scriptPath,
			[
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', (chunk) => { input += chunk; });",
				"process.stdin.on('end', () => {",
				"  const parsed = JSON.parse(input);",
				"  process.stdout.write(JSON.stringify({ cwd: process.cwd(), event: parsed.event, tool: parsed.toolName }));",
				"  process.stderr.write('stderr-marker');",
				"  process.exit(7);",
				"});",
			].join("\n"),
		);
		const input: HookInputWire = {
			cwd,
			event: "PreToolUse",
			toolInput: { command: "pwd" },
			toolName: "Bash",
		};

		// When
		const result = await runCommandHook(createHandler(`${process.execPath} ${scriptPath}`), input, { cwd });

		// Then
		expect(JSON.parse(result.stdout)).toEqual({ cwd, event: "PreToolUse", tool: "Bash" });
		expect(result.stderr).toBe("stderr-marker");
		expect(result.exitCode).toBe(7);
		expect(result.signal).toBeNull();
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
		expect(result.command).toBe(`${process.execPath} ${scriptPath}`);
		expect(result.cwd).toBe(cwd);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("selects commandWindows when the platform is Windows", () => {
		// Given
		const handler = createWindowsHandler("node hooks/posix.mjs", "node hooks/windows.mjs");

		// When
		const windowsCommand = selectCommandForPlatform(handler, "win32");
		const posixCommand = selectCommandForPlatform(handler, "darwin");

		// Then
		expect(windowsCommand).toBe("node hooks/windows.mjs");
		expect(posixCommand).toBe("node hooks/posix.mjs");
	});

	it("kills a long-running command on timeout and leaves no child process", async () => {
		// Given
		const cwd = createTempDir("timeout");
		mkdirSync(cwd, { recursive: true });
		const pidPath = join(cwd, "child.pid");
		const scriptPath = join(cwd, "hang.mjs");
		writeFileSync(
			scriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				`writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		const input: HookInputWire = { cwd, event: "SessionStart", sessionId: "s1" };

		// When
		const result = await runCommandHook(createHandler(`${process.execPath} ${scriptPath}`, { timeout: 1 }), input, {
			cwd,
		});

		// Then
		expect(result.timedOut).toBe(true);
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBeNull();
		expect(result.timeoutSeconds).toBe(1);
		expect(existsSync(pidPath)).toBe(true);
		await waitForProcessExit(Number(readFileSync(pidPath, "utf8")));
	});

	it("rejects invalid timeout values before starting a command", async () => {
		// Given
		const cwd = createTempDir("invalid-timeout");
		mkdirSync(cwd, { recursive: true });
		const input: HookInputWire = { cwd, event: "SessionStart", sessionId: "s1" };

		// Then
		await expect(
			runCommandHook(createHandler('node -e "process.exit(0)"', { timeout: 0 }), input, { cwd }),
		).rejects.toThrow("Invalid command hook timeout reached runtime execution.");
	});

	it("kills a running command when the abort signal fires", async () => {
		// Given
		const cwd = createTempDir("abort");
		mkdirSync(cwd, { recursive: true });
		const pidPath = join(cwd, "child.pid");
		const scriptPath = join(cwd, "abortable.mjs");
		writeFileSync(
			scriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				`writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		const controller = new AbortController();
		const input: HookInputWire = { cwd, event: "UserPromptSubmit", prompt: "hello" };
		const running = runCommandHook(createHandler(`${process.execPath} ${scriptPath}`), input, {
			cwd,
			signal: controller.signal,
		});

		// When
		while (!existsSync(pidPath)) {
			await delay(10);
		}
		controller.abort();
		const result = await running;

		// Then
		expect(result.aborted).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBeNull();
		await waitForProcessExit(Number(readFileSync(pidPath, "utf8")));
	});

	it("caps stdout and stderr in memory before concatenation", async () => {
		// Given
		const cwd = createTempDir("output-cap");
		mkdirSync(cwd, { recursive: true });
		const spillDir = join(cwd, "spill");
		const scriptPath = join(cwd, "large-output.mjs");
		writeFileSync(
			scriptPath,
			["process.stdout.write('o'.repeat(4096));", "process.stderr.write('e'.repeat(4096));"].join("\n"),
		);
		const originalConcat = Buffer.concat;
		const concatSpy = vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
			const observedBytes = totalLength ?? list.reduce((sum, chunk) => sum + chunk.length, 0);
			if (observedBytes > 128) {
				throw new Error(`unbounded Buffer.concat observed ${observedBytes} bytes`);
			}
			return originalConcat(list, totalLength);
		});
		const input: HookInputWire = { cwd, event: "SessionStart", sessionId: "s1" };

		try {
			// When
			const result = await runCommandHook(createHandler(`${process.execPath} ${scriptPath}`), input, {
				cwd,
				outputPolicy: { maxStderrBytes: 128, maxStdoutBytes: 128, spillDir },
			});

			// Then
			expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
			expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(128);
			expect(result.outputSafety.stdout).toEqual(
				expect.objectContaining({ originalBytes: 4096, returnedBytes: 128, spilled: true, truncated: true }),
			);
			expect(result.outputSafety.stderr).toEqual(
				expect.objectContaining({ originalBytes: 4096, returnedBytes: 128, spilled: true, truncated: true }),
			);
			expect(result.outputSafety.stdout.spillPath).toEqual(expect.any(String));
			expect(result.outputSafety.stderr.spillPath).toEqual(expect.any(String));
		} finally {
			concatSpy.mockRestore();
		}
	});
});
