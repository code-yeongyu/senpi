import { describe, expect, it } from "vitest";
import type { HookSourceMetadata, SupportedHookEvent } from "../../src/core/extensions/builtin/hooks/index.ts";
import {
	parseHookConfig,
	SUPPORTED_HOOK_EVENTS,
	UNSUPPORTED_KNOWN_HOOK_EVENTS,
} from "../../src/core/extensions/builtin/hooks/index.ts";

const SOURCE: HookSourceMetadata = {
	discoveredAt: "pre-session",
	displayOrder: 7,
	scope: "project",
	sourcePath: "/repo/.senpi/hooks.json",
};

describe("builtin hooks schema", () => {
	it("normalizes supported Claude and Codex command hook envelopes", () => {
		// Given
		const hooks = Object.fromEntries(
			SUPPORTED_HOOK_EVENTS.map((event) => [
				event,
				[
					{
						matcher: "Bash|Edit",
						hooks: [
							{
								type: "command",
								command: `node hooks/${event}.mjs`,
								timeout: 30,
								statusMessage: `Running ${event}`,
							},
						],
					},
				],
			]),
		);

		// When
		const parsed = parseHookConfig({ hooks }, SOURCE);

		// Then
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.executableHandlers.map((handler) => handler.event)).toEqual(SUPPORTED_HOOK_EVENTS);
		for (const handler of parsed.executableHandlers) {
			expect(handler.matcher).toBe("Bash|Edit");
			expect(handler.config.type).toBe("command");
			expect(handler.config.command).toBe(`node hooks/${handler.event}.mjs`);
			expect(handler.config.timeout).toBe(30);
			expect(handler.config.statusMessage).toBe(`Running ${handler.event}`);
			expect(handler.source).toEqual(SOURCE);
		}
	});

	it("normalizes commandWindows and command_windows aliases", () => {
		// Given
		const config = {
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: "node hooks/posix.mjs",
								commandWindows: "node hooks/windows-camel.mjs",
							},
							{
								type: "command",
								command: "node hooks/posix-two.mjs",
								command_windows: "node hooks/windows-snake.mjs",
							},
						],
					},
				],
			},
		};

		// When
		const parsed = parseHookConfig(config, SOURCE);

		// Then
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.executableHandlers.map((handler) => handler.config.commandWindows)).toEqual([
			"node hooks/windows-camel.mjs",
			"node hooks/windows-snake.mjs",
		]);
	});

	it("keeps unsupported fields, events, and handlers diagnostic-only", () => {
		// Given
		const unsupportedHandlers = [
			{ type: "command", command: "node hooks/condition.mjs", if: "tool.name == 'Bash'" },
			{ type: "command", command: "node hooks/shell.mjs", shell: "bash" },
			{ type: "command", command: { program: "node" }, args: ["hooks/exec-form.mjs"] },
			{ type: "prompt", prompt: "Explain" },
			{ type: "agent", agent: "reviewer" },
			{ type: "http", url: "https://example.test/hook" },
			{ type: "mcp_tool", name: "hook_tool" },
			{ type: "command", command: "node hooks/async.mjs", async: true },
			{ type: "command", command: "node hooks/rewake.mjs", asyncRewake: true },
			{ type: "command", command: "node hooks/terminal.mjs", terminalSequence: "\u001b[31m" },
			{ type: "command", command: "node hooks/continue.mjs", continueOnBlock: true },
		];
		const hooks = Object.fromEntries(
			UNSUPPORTED_KNOWN_HOOK_EVENTS.map((event) => [
				event,
				[{ hooks: [{ type: "command", command: `node hooks/${event}.mjs` }] }],
			]),
		);

		// When
		const parsed = parseHookConfig(
			{
				hooks: {
					...hooks,
					FutureEvent: [{ hooks: [{ type: "command", command: "node hooks/future.mjs" }] }],
					PreToolUse: [{ matcher: "*", hooks: unsupportedHandlers }],
				},
			},
			SOURCE,
		);

		// Then
		expect(parsed.executableHandlers).toEqual([]);
		expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining([
				"unsupported_event",
				"unknown_event",
				"unsupported_field",
				"unsupported_command_variant",
				"unsupported_handler_type",
				"unsupported_async_handler",
			]),
		);
		expect(parsed.diagnostics.some((diagnostic) => diagnostic.path === "hooks.FutureEvent")).toBe(true);
		for (const event of UNSUPPORTED_KNOWN_HOOK_EVENTS) {
			expect(parsed.diagnostics.some((diagnostic) => diagnostic.path === `hooks.${event}`)).toBe(true);
		}
	});

	it("rejects malformed command handlers without making them executable", () => {
		// Given
		const event: SupportedHookEvent = "PreToolUse";

		// When
		const parsed = parseHookConfig(
			{
				hooks: {
					[event]: [{ hooks: [{ type: "command", command: 123 }] }],
				},
			},
			SOURCE,
		);

		// Then
		expect(parsed.executableHandlers).toEqual([]);
		expect(parsed.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "invalid_command",
				event,
				path: "hooks.PreToolUse[0].hooks[0].command",
			}),
		);
	});

	it("rejects invalid command hook timeouts without making handlers executable", () => {
		// Given
		const invalidTimeouts = [
			{ label: "zero", value: 0 },
			{ label: "negative", value: -1 },
			{ label: "nan", value: Number.NaN },
			{ label: "positive-infinity", value: Number.POSITIVE_INFINITY },
			{ label: "negative-infinity", value: Number.NEGATIVE_INFINITY },
		] as const;

		// When
		const parsed = parseHookConfig(
			{
				hooks: {
					PreToolUse: [
						{
							hooks: invalidTimeouts.map((timeout) => ({
								type: "command",
								command: `node hooks/${timeout.label}.mjs`,
								timeout: timeout.value,
							})),
						},
					],
				},
			},
			SOURCE,
		);

		// Then
		expect(parsed.executableHandlers).toEqual([]);
		expect(parsed.diagnostics).toHaveLength(invalidTimeouts.length);
		for (const [index] of invalidTimeouts.entries()) {
			expect(parsed.diagnostics).toContainEqual(
				expect.objectContaining({
					code: "invalid_timeout",
					event: "PreToolUse",
					path: `hooks.PreToolUse[0].hooks[${index}].timeout`,
				}),
			);
		}
	});
});
