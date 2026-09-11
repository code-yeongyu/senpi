import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "../../../src/core/extensions/builtin/claude-sdk-oauth/account-management.ts";
import { AssistantCommitBoundary } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-commit-boundary.ts";

const MODEL_ID = "claude-opus-5";

function evalAssistant(summary: string, code = "return 1"): AssistantMessage {
	return {
		role: "assistant",
		api: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		provider: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		model: MODEL_ID,
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "eval",
				arguments: { language: "js", code, summary },
			},
		],
		stopReason: "toolUse",
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
	};
}

describe("issue #1472: eval summary normalization preserves Claude SDK continuity", () => {
	it("treats the harness 81-to-80 summary clamp as clean", () => {
		const streamed = evalAssistant("s".repeat(81));
		const committed = evalAssistant(`${"s".repeat(77)}...`);
		const boundary = new AssistantCommitBoundary();

		boundary.captureProviderFinal("eval-clamp", streamed);
		expect(boundary.commit("eval-clamp", committed, MODEL_ID)).toBe("clean");
	});

	it("still detects a semantic summary rewrite within the schema limit", () => {
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("summary-rewrite", evalAssistant("inspect cache state"));

		expect(boundary.commit("summary-rewrite", evalAssistant("delete cache state"), MODEL_ID)).toBe("rewritten");
	});

	it("still detects changes to other eval arguments", () => {
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("code-rewrite", evalAssistant("inspect result", "return 1"));

		expect(boundary.commit("code-rewrite", evalAssistant("inspect result", "return 2"), MODEL_ID)).toBe("rewritten");
	});
});
