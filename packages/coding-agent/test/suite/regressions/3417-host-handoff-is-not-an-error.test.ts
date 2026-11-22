import { describe, expect, it } from "vitest";
import { HOST_TOOL_DENIAL_HOOKS } from "../../../src/core/extensions/builtin/anthropic-subscription/tools.ts";

/**
 * Claude Code labels every PreToolUse deny "PreToolUse:<Tool> hook error: <reason>" with is_error true,
 * and that label cannot be changed (senpi#3417). This test owns the contract that the reason the deny
 * hook returns tells the model the handoff is expected and not to report it, while still telling it to
 * wait for senpi's result.
 */
describe("#3417: the host deny hook's reason defuses Claude Code's 'hook error' label", () => {
	it("returns a reason that says the handoff is not an error and must not be mentioned, and still waits for the result", async () => {
		const hook = HOST_TOOL_DENIAL_HOOKS.PreToolUse?.[0]?.hooks?.[0];
		if (!hook) throw new Error("the host deny hook is missing");

		const output = (await hook(
			{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} } as never,
			"toolu_bash",
			{ signal: new AbortController().signal },
		)) as {
			continue?: boolean;
			hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
		};

		const reason = output.hookSpecificOutput?.permissionDecisionReason ?? "";
		expect(output.continue).toBe(false);
		expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
		expect(reason).toMatch(/^Not an error\b/);
		expect(reason).toMatch(/ignore the 'hook error' label/);
		expect(reason).toMatch(/do not mention this message to the user/i);
		expect(reason).toMatch(/returns its result as the next user message/);
	});
});
