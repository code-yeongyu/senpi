import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommandHook } from "../../src/core/extensions/builtin/hooks/command-runner.ts";
import type { PluginHookSourceMetadata } from "../../src/core/extensions/builtin/hooks/plugin-loader.ts";
import { loadPluginHookManifest } from "../../src/core/extensions/builtin/hooks/plugin-loader.ts";
import type { ExecutableHookHandler, HookInputWire } from "../../src/core/extensions/builtin/hooks/types.ts";

const tempRoots: string[] = [];
const PLUGIN_ROOT_TOKEN = "$" + "{PLUGIN_ROOT}";

afterEach(() => {
	delete process.env.SENPI_TEST_ALLOWED;
	delete process.env.SENPI_TEST_DENIED;
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("builtin hooks safety policy", () => {
	it("rejects PLUGIN_ROOT escape targets in command and commandWindows", () => {
		// Given
		const pluginRoot = makePluginRoot({
			hooks: hookConfig(`node ${PLUGIN_ROOT_TOKEN}/../escape.mjs`, `node ${PLUGIN_ROOT_TOKEN}\\..\\escape.ps1`),
		});

		// When
		const loaded = loadPluginHookManifest({ displayOrder: 0, pluginRoot });

		// Then
		expect(loaded.parsed.executableHandlers).toEqual([]);
		expect(loaded.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "invalid_command_target",
					message: expect.stringContaining("outside plugin root"),
					path: "hooks.PreToolUse[0].hooks[0].command",
				}),
				expect.objectContaining({
					code: "invalid_command_target",
					message: expect.stringContaining("outside plugin root"),
					path: "hooks.PreToolUse[0].hooks[0].commandWindows",
				}),
			]),
		);
	});

	it("rejects quoted PLUGIN_ROOT escape suffixes with no executable handler", () => {
		// Given
		const pluginRoot = makePluginRoot({
			hooks: hookConfig(`node "${PLUGIN_ROOT_TOKEN}"/../escape.mjs`, `node "%PLUGIN_ROOT%"/../escape.cmd`),
		});

		// When
		const loaded = loadPluginHookManifest({ displayOrder: 0, pluginRoot });

		// Then
		expect(loaded.parsed.executableHandlers).toEqual([]);
		expect(loaded.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "invalid_command_target",
					message: expect.stringContaining("outside plugin root"),
					path: "hooks.PreToolUse[0].hooks[0].command",
				}),
				expect.objectContaining({
					code: "invalid_command_target",
					message: expect.stringContaining("outside plugin root"),
					path: "hooks.PreToolUse[0].hooks[0].commandWindows",
				}),
			]),
		);
	});

	it("rejects missing PLUGIN_ROOT command targets with diagnostics", () => {
		// Given
		const pluginRoot = makePluginRoot({
			hooks: hookConfig(`node ${PLUGIN_ROOT_TOKEN}/hooks/missing.mjs`),
		});

		// When
		const loaded = loadPluginHookManifest({ displayOrder: 0, pluginRoot });

		// Then
		expect(loaded.parsed.executableHandlers).toEqual([]);
		expect(loaded.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "missing_command_target",
				message: expect.stringContaining("does not exist"),
				path: "hooks.PreToolUse[0].hooks[0].command",
			}),
		);
	});

	it("passes only minimal env, plugin vars, hook vars, and explicit allowlisted env", async () => {
		// Given
		const pluginRoot = makePluginRoot({});
		const source = pluginSource(pluginRoot, join(pluginRoot, "hooks", "hooks.json"));
		const scriptPath = join(pluginRoot, "hooks", "env.mjs");
		mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
		writeFileSync(
			scriptPath,
			[
				"const selected = {",
				"  PLUGIN_ROOT: process.env.PLUGIN_ROOT,",
				"  PLUGIN_DATA: process.env.PLUGIN_DATA,",
				"  CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,",
				"  CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,",
				"  SENPI_HOOK_SOURCE: process.env.SENPI_HOOK_SOURCE,",
				"  SENPI_HOOK_EVENT: process.env.SENPI_HOOK_EVENT,",
				"  SENPI_TEST_ALLOWED: process.env.SENPI_TEST_ALLOWED,",
				"  SENPI_TEST_DENIED: process.env.SENPI_TEST_DENIED,",
				"  PATH: process.env.PATH,",
				"};",
				"process.stdout.write(JSON.stringify(selected));",
			].join("\n"),
		);
		process.env.SENPI_TEST_ALLOWED = "allowed-value";
		process.env.SENPI_TEST_DENIED = "denied-value";
		const input: HookInputWire = { cwd: pluginRoot, event: "SessionStart", sessionId: "s1" };

		// When
		const result = await runCommandHook(createHandler(`${process.execPath} ${scriptPath}`, source), input, {
			cwd: pluginRoot,
			envPassthrough: ["SENPI_TEST_ALLOWED"],
		});

		// Then
		expect(JSON.parse(result.stdout)).toEqual({
			CLAUDE_PLUGIN_DATA: join(pluginRoot, ".plugin-data"),
			CLAUDE_PLUGIN_ROOT: pluginRoot,
			PATH: expect.any(String),
			PLUGIN_DATA: join(pluginRoot, ".plugin-data"),
			PLUGIN_ROOT: pluginRoot,
			SENPI_HOOK_EVENT: "SessionStart",
			SENPI_HOOK_SOURCE: source.sourcePath,
			SENPI_TEST_ALLOWED: "allowed-value",
		});
	});

	it("bounds, redacts, and spills large stdout and stderr", async () => {
		// Given
		const pluginRoot = makePluginRoot({});
		const spillDir = join(pluginRoot, "spill");
		const scriptPath = join(pluginRoot, "hooks", "large.mjs");
		mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
		writeFileSync(
			scriptPath,
			[
				"process.stdout.write('SECRET_TOKEN=stdout-secret\\n' + 'o'.repeat(200));",
				"process.stderr.write('Authorization: Bearer stderr-secret\\n' + 'e'.repeat(200));",
			].join("\n"),
		);
		const input: HookInputWire = { cwd: pluginRoot, event: "SessionStart", sessionId: "s1" };

		// When
		const result = await runCommandHook(
			createHandler(`${process.execPath} ${scriptPath}`, pluginSource(pluginRoot)),
			input,
			{
				cwd: pluginRoot,
				outputPolicy: { maxStderrBytes: 64, maxStdoutBytes: 64, spillDir },
			},
		);

		// Then
		expect(result.stdout).toContain("[REDACTED]");
		expect(result.stderr).toContain("[REDACTED]");
		expect(result.stdout).not.toContain("stdout-secret");
		expect(result.stderr).not.toContain("stderr-secret");
		expect(result.outputSafety.stdout).toEqual(
			expect.objectContaining({ redacted: true, spilled: true, truncated: true }),
		);
		expect(result.outputSafety.stderr).toEqual(
			expect.objectContaining({ redacted: true, spilled: true, truncated: true }),
		);
		expect(result.outputSafety.stdout.spillPath).toEqual(expect.any(String));
		expect(result.outputSafety.stderr.spillPath).toEqual(expect.any(String));
		expect(readFileSync(result.outputSafety.stdout.spillPath ?? "", "utf8")).not.toContain("stdout-secret");
		expect(readFileSync(result.outputSafety.stderr.spillPath ?? "", "utf8")).not.toContain("stderr-secret");
	});

	it("uses the Codex-compatible 600 second timeout by default", async () => {
		// Given
		const pluginRoot = makePluginRoot({});
		const scriptPath = join(pluginRoot, "hooks", "quick.mjs");
		mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
		writeFileSync(scriptPath, "process.stdout.write('ok');\n");
		const input: HookInputWire = { cwd: pluginRoot, event: "SessionStart", sessionId: "s1" };

		// When
		const result = await runCommandHook(
			createHandler(`${process.execPath} ${scriptPath}`, pluginSource(pluginRoot)),
			input,
			{
				cwd: pluginRoot,
			},
		);

		// Then
		expect(result.timeoutSeconds).toBe(600);
		expect(result.timedOut).toBe(false);
	});
});

function createHandler(command: string, source: PluginHookSourceMetadata): ExecutableHookHandler {
	return {
		config: { command, type: "command" },
		event: "SessionStart",
		groupIndex: 0,
		handlerIndex: 0,
		source,
	};
}

function hookConfig(command: string, commandWindows?: string): unknown {
	return {
		hooks: {
			PreToolUse: [
				{
					hooks: [
						{
							command,
							...(commandWindows === undefined ? {} : { commandWindows }),
							type: "command",
						},
					],
				},
			],
		},
	};
}

function makePluginRoot(manifest: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-hooks-safety-"));
	tempRoots.push(root);
	mkdirSync(join(root, ".codex-plugin"), { recursive: true });
	writeJson(join(root, ".codex-plugin", "plugin.json"), manifest);
	return root;
}

function pluginSource(
	pluginRoot: string,
	sourcePath = join(pluginRoot, "hooks", "hooks.json"),
): PluginHookSourceMetadata {
	return {
		discoveredAt: "pre-session",
		displayOrder: 0,
		manifestPath: join(pluginRoot, ".codex-plugin", "plugin.json"),
		pluginEnv: {
			CLAUDE_PLUGIN_DATA: join(pluginRoot, ".plugin-data"),
			CLAUDE_PLUGIN_ROOT: pluginRoot,
			PLUGIN_DATA: join(pluginRoot, ".plugin-data"),
			PLUGIN_ROOT: pluginRoot,
		},
		pluginRoot,
		scope: "plugin",
		sourcePath,
	};
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
