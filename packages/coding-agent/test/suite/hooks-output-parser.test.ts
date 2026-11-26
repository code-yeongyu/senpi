import { describe, expect, it } from "vitest";
import type { HookSourceMetadata, SupportedHookEvent } from "../../src/core/extensions/builtin/hooks/index.ts";
import { parseHookOutput } from "../../src/core/extensions/builtin/hooks/output-parser.ts";

const SOURCE: HookSourceMetadata = {
	discoveredAt: "runtime",
	displayOrder: 3,
	scope: "project",
	sourcePath: "/repo/.senpi/hooks.json",
};

function parse(
	event: SupportedHookEvent,
	stdout: string,
	options?: { readonly exitCode?: number; readonly stderr?: string },
) {
	return parseHookOutput({
		event,
		exitCode: options?.exitCode ?? 0,
		source: SOURCE,
		stderr: options?.stderr ?? "",
		stdout,
	});
}

describe("builtin hooks output parser", () => {
	it("returns no decision when a successful hook writes empty stdout", () => {
		// Given / When
		const parsed = parse("PreToolUse", "");

		// Then
		expect(Object.keys(parsed).sort()).toEqual(["diagnostics", "output"]);
		expect(parsed.output).toEqual({});
		expect(parsed.diagnostics).toEqual([]);
	});

	it("diagnoses malformed stdout JSON unless exit code 2 blocks from stderr", () => {
		// Given / When
		const malformedInput = parse("PostToolUse", "{not json");
		const blocking = parse("PostToolUse", "{not json", { exitCode: 2, stderr: "policy blocked" });

		// Then
		expect(malformedInput.output).toEqual({});
		expect(malformedInput.diagnostics).toContainEqual(
			expect.objectContaining({ code: "invalid_root", path: "stdout" }),
		);
		expect(blocking.output).toEqual({ decision: "block", reason: "policy blocked" });
		expect(blocking.diagnostics).toEqual([]);
	});

	it("parses PreToolUse allow updated input, deny, and mismatched event diagnostics", () => {
		// Given / When
		const allow = parse(
			"PreToolUse",
			JSON.stringify({
				continue: true,
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "allow",
					permissionDecisionReason: "safe",
					updatedInput: { command: "printf ok" },
					additionalContext: "lint gate passed",
				},
			}),
		);
		const deny = parse(
			"PreToolUse",
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: "dangerous command",
					updatedInput: { command: "ignored" },
				},
			}),
		);
		const staleState = parse(
			"PreToolUse",
			JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "wrong event" } }),
		);
		const approveWithUpdatedInput = parse(
			"PreToolUse",
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "approve",
					updatedInput: { command: "ignored" },
				},
			}),
		);

		// Then
		expect(allow.output).toEqual({
			additionalContext: "lint gate passed",
			continue: true,
			decision: "allow",
			reason: "safe",
			updatedInput: { command: "printf ok" },
		});
		expect(allow.diagnostics).toEqual([]);
		expect(deny.output).toEqual({ decision: "deny", reason: "dangerous command" });
		expect(deny.diagnostics).toContainEqual(
			expect.objectContaining({ code: "unsupported_field", path: "stdout.hookSpecificOutput.updatedInput" }),
		);
		expect(staleState.output).toEqual({});
		expect(staleState.diagnostics).toContainEqual(
			expect.objectContaining({ code: "invalid_event_config", path: "stdout.hookSpecificOutput.hookEventName" }),
		);
		expect(approveWithUpdatedInput.output).toEqual({ decision: "approve" });
		expect(approveWithUpdatedInput.diagnostics).toContainEqual(
			expect.objectContaining({ code: "unsupported_field", path: "stdout.hookSpecificOutput.updatedInput" }),
		);
	});

	it("parses PostToolUse context, block, and updated tool output where representable", () => {
		// Given / When
		const context = parse(
			"PostToolUse",
			JSON.stringify({
				decision: "block",
				reason: "redacted output",
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					additionalContext: "tool result contained secrets",
					updatedToolOutput: "redacted",
				},
			}),
		);

		// Then
		expect(context.output).toEqual({
			additionalContext: "tool result contained secrets",
			decision: "block",
			reason: "redacted output",
			updatedToolOutput: "redacted",
		});
		expect(context.diagnostics).toEqual([]);
	});

	it("parses UserPromptSubmit block/additionalContext and rejects prompt replacement", () => {
		// Given / When
		const parsed = parse(
			"UserPromptSubmit",
			JSON.stringify({
				decision: "block",
				reason: "missing ticket",
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "Use ticket SION-123",
					prompt: "replacement should not be applied",
				},
			}),
		);

		// Then
		expect(parsed.output).toEqual({
			additionalContext: "Use ticket SION-123",
			decision: "block",
			reason: "missing ticket",
		});
		expect(parsed.diagnostics).toContainEqual(
			expect.objectContaining({ code: "unsupported_field", path: "stdout.hookSpecificOutput.prompt" }),
		);
	});

	it("parses Stop and SessionStart context plus intended universal fields", () => {
		// Given / When
		const stop = parse(
			"Stop",
			JSON.stringify({
				continue: false,
				stopReason: "quality gate failed",
				suppressOutput: true,
				systemMessage: "Tell the user the gate failed",
				hookSpecificOutput: { hookEventName: "Stop", additionalContext: "rerun npm run check" },
			}),
		);
		const sessionStart = parse(
			"SessionStart",
			JSON.stringify({
				systemMessage: "Project instructions loaded",
				hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Prefer strict hooks." },
			}),
		);
		const unsupportedUniversal = parse("PreCompact", JSON.stringify({ systemMessage: "not representable here" }));

		// Then
		expect(stop.output).toEqual({
			additionalContext: "rerun npm run check",
			continue: false,
			decision: "block",
			stopReason: "quality gate failed",
			suppressOutput: true,
			systemMessage: "Tell the user the gate failed",
		});
		expect(stop.diagnostics).toEqual([]);
		expect(sessionStart.output).toEqual({
			additionalContext: "Prefer strict hooks.",
			systemMessage: "Project instructions loaded",
		});
		expect(sessionStart.diagnostics).toEqual([]);
		expect(unsupportedUniversal.output).toEqual({});
		expect(unsupportedUniversal.diagnostics).toContainEqual(
			expect.objectContaining({ code: "unsupported_field", path: "stdout.systemMessage" }),
		);
	});

	it("accepts plain-text stdout as additionalContext for exit-0 SessionStart hooks only", () => {
		const plain = parse("SessionStart", "You are running inside Rex.\nUse `rex capture` to inspect panes.\n");
		const failed = parse("SessionStart", "fatal traceback: secret", { exitCode: 1 });
		const jsonArray = parse("SessionStart", "[1, 2, 3]");
		const otherEvent = parse("UserPromptSubmit", "plain text should stay invalid");

		expect(plain.output).toEqual({
			additionalContext: "You are running inside Rex.\nUse `rex capture` to inspect panes.",
		});
		expect(plain.diagnostics).toEqual([]);
		expect(failed.output).toEqual({});
		expect(failed.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_root", path: "stdout" }));
		expect(jsonArray.output).toEqual({});
		expect(jsonArray.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_root", path: "stdout" }));
		expect(otherEvent.output).toEqual({});
		expect(otherEvent.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_root", path: "stdout" }));
	});
});
