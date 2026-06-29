import { describe, expect, it } from "vitest";
import { matchingHookHandlers } from "../../src/core/extensions/builtin/hooks/matcher.ts";
import type {
	ExecutableHookHandler,
	HookInputWire,
	HookSourceMetadata,
	SupportedHookEvent,
} from "../../src/core/extensions/builtin/hooks/types.ts";

const SOURCE: HookSourceMetadata = {
	discoveredAt: "pre-session",
	displayOrder: 11,
	scope: "project",
	sourcePath: "/repo/.senpi/hooks.json",
};

function handler(event: SupportedHookEvent, matcher: string | undefined, command: string): ExecutableHookHandler {
	const base = {
		config: { type: "command", command },
		event,
		groupIndex: 0,
		handlerIndex: 0,
		source: SOURCE,
	} satisfies Omit<ExecutableHookHandler, "matcher">;
	if (matcher === undefined) {
		return base;
	}
	return { ...base, matcher };
}

function preToolUse(toolName: string): HookInputWire {
	return { cwd: "/repo", event: "PreToolUse", toolInput: {}, toolName };
}

describe("builtin hooks matcher", () => {
	it("selects tool handlers across match-all, exact, lists, regex, and aliases once", () => {
		// Given
		const handlers = [
			handler("PreToolUse", undefined, "omitted"),
			handler("PreToolUse", "", "empty"),
			handler("PreToolUse", "*", "star"),
			handler("PreToolUse", "bash", "senpi"),
			handler("PreToolUse", "Bash", "claude"),
			handler("PreToolUse", "shell", "codex-shell"),
			handler("PreToolUse", "exec_command", "codex-exec"),
			handler("PreToolUse", "Read|Edit|Bash", "pipe-list"),
			handler("PreToolUse", "Read, Edit, Bash", "comma-list"),
			handler("PreToolUse", "^(Read|Bash)$", "regex"),
			handler("PreToolUse", "bash|Bash|shell|exec_command", "multi-alias-once"),
			handler("PreToolUse", "Read", "miss"),
		];

		// When
		const result = matchingHookHandlers(preToolUse("bash"), handlers);

		// Then
		expect(result.diagnostics).toEqual([]);
		expect(result.handlers.map((hook) => hook.config.command)).toEqual([
			"omitted",
			"empty",
			"star",
			"senpi",
			"claude",
			"codex-shell",
			"codex-exec",
			"pipe-list",
			"comma-list",
			"regex",
			"multi-alias-once",
		]);
	});

	it("diagnoses invalid regex matchers and falls back to literal list matching", () => {
		// Given
		const handlers = [
			handler("PreToolUse", "Bash, malformed_input(", "fallback-hit"),
			handler("PreToolUse", "malformed_input(", "fallback-miss"),
		];

		// When
		const result = matchingHookHandlers(preToolUse("bash"), handlers);

		// Then
		expect(result.handlers.map((hook) => hook.config.command)).toEqual(["fallback-hit"]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "invalid_matcher",
				event: "PreToolUse",
				path: "hooks.PreToolUse[0].matcher",
				source: SOURCE,
			}),
			expect.objectContaining({
				code: "invalid_matcher",
				event: "PreToolUse",
				path: "hooks.PreToolUse[0].matcher",
				source: SOURCE,
			}),
		]);
	});

	it("ignores matcher filtering for user prompt and stop events", () => {
		// Given
		const handlers = [handler("UserPromptSubmit", "malformed_input(", "prompt"), handler("Stop", "Read", "stop")];
		const promptInput: HookInputWire = { cwd: "/repo", event: "UserPromptSubmit", prompt: "hello" };
		const stopInput: HookInputWire = { cwd: "/repo", event: "Stop", stopReason: "stop" };

		// When
		const promptResult = matchingHookHandlers(promptInput, handlers);
		const stopResult = matchingHookHandlers(stopInput, handlers);

		// Then
		expect(promptResult.diagnostics).toEqual([]);
		expect(promptResult.handlers.map((hook) => hook.config.command)).toEqual(["prompt"]);
		expect(stopResult.diagnostics).toEqual([]);
		expect(stopResult.handlers.map((hook) => hook.config.command)).toEqual(["stop"]);
	});
});
