import { describe, expect, it } from "vitest";
import type { AssistantMessage, ProviderNativeContent } from "../src/types.js";

describe("ProviderNativeContent typing", () => {
	it("allows provider-native blocks in AssistantMessage.content", () => {
		const providerNativeBlock: ProviderNativeContent = {
			type: "providerNative",
			subtype: "server_tool_use",
			raw: {
				id: "srvtoolu_xx",
				name: "web_search",
				input: {
					query: "test",
				},
			},
		};

		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "native block follows",
				},
				providerNativeBlock,
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		expect(message.content).toHaveLength(2);
		expect(message.content[1]).toEqual(providerNativeBlock);
	});
});
