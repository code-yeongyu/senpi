import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildClaudeSdkOauthQueryOptions } from "../../../src/core/extensions/builtin/claude-sdk-oauth/options.ts";

const MODEL: Model<Api> = {
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const CONTEXT: Context = { messages: [] };

describe("issue #494: Claude SDK OAuth denied tool replay", () => {
	it("terminally stops the SDK turn with continue:false for native and custom MCP host-captured tools", async () => {
		// Given: the inference-only SDK adapter options.
		const options = buildClaudeSdkOauthQueryOptions({
			model: MODEL,
			context: CONTEXT,
			cwd: "/tmp",
			providerSettings: { appendSystemPrompt: false },
			authLane: "oauth-slots",
		});

		// When: the SDK resolves its pre-execution hook for host-captured tools.
		const matcher = options.hooks?.PreToolUse?.[0];
		const hook = matcher?.hooks[0];
		if (matcher?.matcher === undefined || hook === undefined) {
			throw new Error("Expected a PreToolUse denial hook for host-captured tools");
		}
		const matches = new RegExp(`^(?:${matcher.matcher})$`);
		const output = await hook(
			{
				hook_event_name: "PreToolUse",
				session_id: "session-494",
				transcript_path: "/tmp/session-494.jsonl",
				cwd: "/tmp",
				tool_name: "Bash",
				tool_input: { command: "echo once >> probe.txt" },
				tool_use_id: "tool-494",
			},
			"tool-494",
			{ signal: new AbortController().signal },
		);

		// Then: every Senpi-captured SDK tool is intercepted with a terminal, non-inciting denial.
		expect(
			["Bash", "Write", "Edit", "Read", "Grep", "Glob", "mcp__custom-tools__eval"].every((name) =>
				matches.test(name),
			),
		).toBe(true);
		expect(matches.test("WebSearch")).toBe(false);
		expect(output).toEqual({
			continue: false,
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: expect.stringMatching(
					/senpi executes this tool on the host.*this denial is not a failure/i,
				),
			},
		});
	});
});
