import { describe, expect, it } from "vitest";
import { loadHookConfigSources } from "../../src/core/extensions/builtin/hooks/config-loader.ts";

function commandHook(command: string, event = "PreToolUse"): string {
	return JSON.stringify({
		hooks: {
			[event]: [
				{
					matcher: "*",
					hooks: [{ type: "command", command }],
				},
			],
		},
	});
}

describe("builtin hooks config loader", () => {
	it("merges explicit hook sources in canonical deterministic order", () => {
		// Given
		const files: Readonly<Record<string, string>> = {
			"/home/agent/hooks.json": commandHook("global-file"),
			"/repo/.senpi/hooks.json": commandHook("project-file"),
			"/repo/plugin-a/hooks.json": commandHook("pre-session-a"),
			"/repo/plugin-b/hooks.json": commandHook("pre-session-b"),
			"/repo/runtime/hooks.json": commandHook("runtime"),
		};

		// When
		const parsed = loadHookConfigSources({
			agentDir: "/home/agent",
			cwd: "/repo",
			fileSystem: {
				readTextFile: (path) => files[path],
			},
			globalHooksPath: "/home/agent/hooks.json",
			globalSettingsHooks: {
				PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "global-inline" }] }],
			},
			preSessionHookSourcePaths: ["/repo/plugin-a/hooks.json", "/repo/plugin-b/hooks.json"],
			projectHooksPath: "/repo/.senpi/hooks.json",
			projectSettingsHooks: {
				PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "project-inline" }] }],
			},
			runtimeHookSourcePaths: ["/repo/runtime/hooks.json"],
		});

		// Then
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.executableHandlers.map((handler) => handler.config.command)).toEqual([
			"global-inline",
			"global-file",
			"project-inline",
			"project-file",
			"pre-session-a",
			"pre-session-b",
			"runtime",
		]);
		expect(parsed.executableHandlers.map((handler) => handler.source)).toEqual([
			{
				discoveredAt: "pre-session",
				displayOrder: 0,
				scope: "global",
				sourcePath: "<global-settings-hooks>",
			},
			{
				discoveredAt: "pre-session",
				displayOrder: 1,
				scope: "global",
				sourcePath: "/home/agent/hooks.json",
			},
			{
				discoveredAt: "pre-session",
				displayOrder: 2,
				scope: "project",
				sourcePath: "<project-settings-hooks>",
			},
			{
				discoveredAt: "pre-session",
				displayOrder: 3,
				scope: "project",
				sourcePath: "/repo/.senpi/hooks.json",
			},
			{
				discoveredAt: "pre-session",
				displayOrder: 4,
				scope: "plugin",
				sourcePath: "/repo/plugin-a/hooks.json",
			},
			{
				discoveredAt: "pre-session",
				displayOrder: 5,
				scope: "plugin",
				sourcePath: "/repo/plugin-b/hooks.json",
			},
			{
				discoveredAt: "runtime",
				displayOrder: 6,
				scope: "runtime",
				sourcePath: "/repo/runtime/hooks.json",
			},
		]);
	});

	it("accumulates diagnostics without dropping earlier or later valid sources", () => {
		// Given
		const files: Readonly<Record<string, string>> = {
			"/home/agent/hooks.json": "{",
			"/repo/.senpi/hooks.json": JSON.stringify({ hooks: "bad" }),
			"/repo/plugin/hooks.json": commandHook("plugin-valid"),
			"/repo/runtime/hooks.json": commandHook("runtime-session-start", "SessionStart"),
		};

		// When
		const parsed = loadHookConfigSources({
			agentDir: "/home/agent",
			cwd: "/repo",
			fileSystem: {
				readTextFile: (path) => files[path],
			},
			globalHooksPath: "/home/agent/hooks.json",
			globalSettingsHooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: "global-valid" }] }],
			},
			preSessionHookSourcePaths: ["/repo/plugin/hooks.json"],
			projectHooksPath: "/repo/.senpi/hooks.json",
			runtimeHookSourcePaths: ["/repo/runtime/hooks.json"],
		});

		// Then
		expect(parsed.executableHandlers.map((handler) => handler.config.command)).toEqual([
			"global-valid",
			"plugin-valid",
			"runtime-session-start",
		]);
		expect(parsed.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "invalid_root",
					path: "$",
					source: expect.objectContaining({ sourcePath: "/home/agent/hooks.json" }),
				}),
				expect.objectContaining({
					code: "invalid_hooks",
					path: "hooks",
					source: expect.objectContaining({ sourcePath: "/repo/.senpi/hooks.json" }),
				}),
				expect.objectContaining({
					code: "unsupported_event",
					event: "SessionStart",
					path: "hooks.SessionStart",
					severity: "warning",
					source: expect.objectContaining({
						discoveredAt: "runtime",
						sourcePath: "/repo/runtime/hooks.json",
					}),
				}),
			]),
		);
	});
});
