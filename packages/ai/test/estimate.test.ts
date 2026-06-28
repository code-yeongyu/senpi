import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { estimateMessageTokens } from "../src/utils/estimate.ts";

describe("estimateMessageTokens", () => {
	it("estimates providerNative assistant content without treating it as a tool call", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "providerNative",
					subtype: "web_search_call",
					raw: { type: "web_search_call", query: "pi" },
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};

		expect(estimateMessageTokens(message)).toBe(14);
	});
});
