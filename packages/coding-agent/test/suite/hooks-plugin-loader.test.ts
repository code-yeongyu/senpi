import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadPluginHookManifest,
	selectHookCommandForPlatform,
} from "../../src/core/extensions/builtin/hooks/plugin-loader.ts";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { force: true, recursive: true });
	}
});

describe("plugin hook manifest loader", () => {
	it("loads plugin path hooks, inline hooks, default hooks, and root metadata", () => {
		// Given
		const pluginRoot = makePluginRoot();
		const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
		const pluginRootCommand = ["node $", "{PLUGIN_ROOT}/hooks/one.mjs"].join("");
		writeJson(join(pluginRoot, "hooks", "one.json"), hookConfig(pluginRootCommand));
		writeJson(join(pluginRoot, "hooks", "two.json"), hookConfig("node hooks/two.mjs"));
		writeJson(join(pluginRoot, "hooks", "hooks.json"), hookConfig("node hooks/default.mjs"));
		writeJson(manifestPath, {
			hooks: [
				"./hooks/one.json",
				["hooks/two.json"],
				hookConfig("node inline-one.mjs"),
				[hookConfig("node inline-two.mjs")],
			],
		});

		// When
		const fromManifest = loadPluginHookManifest({ displayOrder: 3, pluginRoot });
		const fromDefault = loadPluginHookManifest({
			displayOrder: 9,
			includeDefaultHooks: true,
			pluginRoot: makePluginRootWithDefaultHook(),
		});

		// Then
		expect(fromManifest.diagnostics).toEqual([]);
		expect(fromManifest.parsed.executableHandlers.map((handler) => handler.config.command)).toEqual([
			pluginRootCommand,
			"node hooks/two.mjs",
			"node inline-one.mjs",
			"node inline-two.mjs",
			"node hooks/default.mjs",
		]);
		expect(fromManifest.sources.map((source) => source.sourcePath)).toEqual([
			join(pluginRoot, "hooks", "one.json"),
			join(pluginRoot, "hooks", "two.json"),
			`${manifestPath}#hooks[2]`,
			`${manifestPath}#hooks[3][0]`,
			join(pluginRoot, "hooks", "hooks.json"),
		]);
		for (const source of fromManifest.sources) {
			expect(source.scope).toBe("plugin");
			expect(source.pluginRoot).toBe(pluginRoot);
			expect(source.manifestPath).toBe(manifestPath);
			expect(source.pluginEnv).toEqual({
				CLAUDE_PLUGIN_DATA: join(pluginRoot, ".plugin-data"),
				CLAUDE_PLUGIN_ROOT: pluginRoot,
				PLUGIN_DATA: join(pluginRoot, ".plugin-data"),
				PLUGIN_ROOT: pluginRoot,
			});
		}
		expect(fromDefault.parsed.executableHandlers.map((handler) => handler.config.command)).toEqual([
			"node hooks/default-only.mjs",
		]);
	});

	it("rejects malformed manifest paths, missing files, and plugin root escapes", () => {
		// Given
		const missingRoot = makePluginRoot({ hooks: "./hooks/missing.json" });
		const escapeRoot = makePluginRoot({ hooks: "../escape.json" });
		const malformedRoot = makePluginRoot({ hooks: [123] });

		// When
		const missing = loadPluginHookManifest({ displayOrder: 0, pluginRoot: missingRoot });
		const escapedPath = loadPluginHookManifest({ displayOrder: 0, pluginRoot: escapeRoot });
		const malformed = loadPluginHookManifest({ displayOrder: 0, pluginRoot: malformedRoot });

		// Then
		expect(missing.parsed.executableHandlers).toEqual([]);
		expect(missing.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid_root",
				path: "$.hooks",
			}),
		);
		expect(escapedPath.parsed.executableHandlers).toEqual([]);
		expect(escapedPath.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid_root",
				message: expect.stringContaining("outside plugin root"),
				path: "$.hooks",
			}),
		);
		expect(malformed.parsed.executableHandlers).toEqual([]);
		expect(malformed.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid_root",
				path: "$.hooks[0]",
			}),
		);
	});

	it("normalizes Windows separators and selects platform-specific commands", () => {
		// Given
		const pluginRoot = makePluginRoot({
			hooks: ".\\hooks\\windows.json",
		});
		writeJson(join(pluginRoot, "hooks", "windows.json"), {
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: "node hooks/posix.mjs",
								commandWindows: "node hooks/windows.mjs",
							},
						],
					},
				],
			},
		});

		// When
		const loaded = loadPluginHookManifest({ displayOrder: 0, pluginRoot });
		const handler = loaded.parsed.executableHandlers[0];

		// Then
		expect(loaded.diagnostics).toEqual([]);
		expect(handler?.source.sourcePath).toBe(join(pluginRoot, "hooks", "windows.json"));
		expect(handler ? selectHookCommandForPlatform(handler, "win32") : undefined).toBe("node hooks/windows.mjs");
		expect(handler ? selectHookCommandForPlatform(handler, "darwin") : undefined).toBe("node hooks/posix.mjs");
	});
});

function makePluginRoot(manifest?: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-hooks-plugin-"));
	tempRoots.push(root);
	mkdirSync(join(root, ".codex-plugin"), { recursive: true });
	writeJson(join(root, ".codex-plugin", "plugin.json"), manifest ?? {});
	return root;
}

function makePluginRootWithDefaultHook(): string {
	const root = makePluginRoot();
	mkdirSync(join(root, "hooks"), { recursive: true });
	writeJson(join(root, "hooks", "hooks.json"), hookConfig("node hooks/default-only.mjs"));
	return root;
}

function hookConfig(command: string): unknown {
	return {
		hooks: {
			PreToolUse: [
				{
					hooks: [{ type: "command", command }],
				},
			],
		},
	};
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
