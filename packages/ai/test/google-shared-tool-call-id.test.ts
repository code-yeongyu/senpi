import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/google-shared.ts";
import type { Context, Model } from "../src/types.ts";

function makeClaudeViaGoogleModel(): Model<"google-generative-ai"> {
	// Claude models behind Google APIs require explicit tool call IDs.
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

describe("google-shared tool call id normalization", () => {
	it("never collides when truncating long foreign tool call ids sharing a 64-char prefix", () => {
		const model = makeClaudeViaGoogleModel();
		const sharedPrefix = `call_${"A".repeat(200)}`;
		const now = Date.now();
		const context: Context = {
			messages: [
				{ role: "user", content: "run tools", timestamp: now - 3000 },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: `${sharedPrefix}1111`, name: "bash", arguments: {} },
						{ type: "toolCall", id: `${sharedPrefix}2222`, name: "read", arguments: {} },
					],
					api: "openai-completions",
					provider: "moonshot",
					model: "kimi-k2-6",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: now - 2000,
				},
				{
					role: "toolResult",
					toolCallId: `${sharedPrefix}1111`,
					toolName: "bash",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: now - 1000,
				},
				{
					role: "toolResult",
					toolCallId: `${sharedPrefix}2222`,
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: now - 1000,
				},
			],
		};

		const contents = convertMessages(model, context);

		const callIds =
			contents
				.find((c) => c.role === "model")
				?.parts?.map((part) => part.functionCall?.id)
				.filter((id): id is string => id !== undefined) ?? [];
		const responseIds =
			contents
				.filter((c) => c.role === "user")
				.flatMap((c) => c.parts ?? [])
				.map((part) => part.functionResponse?.id)
				.filter((id): id is string => id !== undefined) ?? [];

		expect(callIds).toHaveLength(2);
		expect(new Set(callIds).size).toBe(2);
		expect(new Set(responseIds)).toEqual(new Set(callIds));
		for (const id of callIds) {
			expect(id.length).toBeLessThanOrEqual(64);
			expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
		}
	});
});
