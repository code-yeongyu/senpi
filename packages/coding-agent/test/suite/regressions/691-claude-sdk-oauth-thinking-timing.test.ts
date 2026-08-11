import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "../../../src/core/extensions/builtin/claude-sdk-oauth/account-management.ts";
import { AssistantCommitBoundary } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-commit-boundary.ts";

function assistantMessage(timing?: { startedAt: number; endedAt?: number }, text = "same answer"): AssistantMessage {
	return {
		role: "assistant",
		api: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		provider: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		model: "claude-fable-5",
		content: [
			{
				type: "thinking",
				thinking: "same reasoning",
				thinkingSignature: "signature",
				...timing,
			},
			{ type: "text", text },
		],
		stopReason: "stop",
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

describe("issue #691: Claude SDK OAuth thinking timing continuity", () => {
	it("ignores post-stream timing metadata without hiding semantic rewrites", () => {
		const streamed = assistantMessage();
		const timingOnlyCommit = new AssistantCommitBoundary();
		for (let turn = 1; turn <= 10; turn += 1) {
			const key = `timing-${turn}`;
			const timing =
				turn % 2 === 0 ? { startedAt: turn * 100, endedAt: turn * 100 + 50 } : { startedAt: turn * 100 };
			const timingEnriched = assistantMessage(timing);
			timingOnlyCommit.captureProviderFinal(key, streamed);

			expect(timingOnlyCommit.commit(key, timingEnriched, streamed.model)).toBe("clean");
			expect(timingEnriched.content[0]).toMatchObject(timing);
		}

		const changedThinking = assistantMessage();
		const thinkingBlock = changedThinking.content[0];
		if (thinkingBlock?.type !== "thinking") throw new Error("Expected the first block to contain thinking");
		thinkingBlock.thinking = "changed reasoning";
		const thinkingCommit = new AssistantCommitBoundary();
		thinkingCommit.captureProviderFinal("thinking", streamed);
		expect(thinkingCommit.commit("thinking", changedThinking, streamed.model)).toBe("rewritten");

		const changedSignature = assistantMessage();
		const signatureBlock = changedSignature.content[0];
		if (signatureBlock?.type !== "thinking") throw new Error("Expected the first block to contain thinking");
		signatureBlock.thinkingSignature = "changed signature";
		const signatureCommit = new AssistantCommitBoundary();
		signatureCommit.captureProviderFinal("signature", streamed);
		expect(signatureCommit.commit("signature", changedSignature, streamed.model)).toBe("rewritten");

		const textCommit = new AssistantCommitBoundary();
		textCommit.captureProviderFinal("text", streamed);
		expect(
			textCommit.commit(
				"text",
				assistantMessage({ startedAt: 100, endedAt: 200 }, "changed answer"),
				streamed.model,
			),
		).toBe("rewritten");
	});
});
