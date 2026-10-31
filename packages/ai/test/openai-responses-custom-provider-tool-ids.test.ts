import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model, ToolResultMessage, Usage } from "../src/types.ts";
import { shortHash } from "../src/utils/hash.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createMockCommandCodeModel(): Model<"openai-responses"> {
	return {
		id: "deepseek/deepseek-v4.1-flash",
		provider: "commandcode",
		api: "openai-responses",
		name: "DeepSeek V4.1 Flash",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 8192,
	};
}

describe("OpenAI Responses custom provider tool-call ID serialization (#4395)", () => {
	it("preserves foreign tool call IDs with compliant fc_ prefixes when targeting commandcode", () => {
		const targetModel = createMockCommandCodeModel();

		const geminiCallId = "call_gemini_test_12345|tool-response-part-0";
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: geminiCallId,
					name: "eval",
					arguments: { code: 'console.log("hello");' },
				},
			],
			api: "google-generative-ai",
			provider: "antigravity",
			model: "gemini-3.8-flash",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now() - 2000,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: geminiCallId,
			toolName: "eval",
			content: [{ type: "text", text: "hello\n" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};
		const context = normalizeContext({
			systemPrompt: "You are a coding assistant.",
			messages: [{ role: "user", content: "Run the code.", timestamp: Date.now() - 3000 }, assistant, toolResult],
		});

		const allowedProviders = new Set(["openai", "chatgpt-subscription", "opencode"]);
		const input = convertResponsesMessages(targetModel, context, allowedProviders);

		const functionCall = input.find((item) => item.type === "function_call");
		expect(functionCall).toBeDefined();
		if (functionCall?.type !== "function_call") {
			throw new Error("Expected function_call item");
		}

		expect(functionCall.id).toBeDefined();
		expect(functionCall.id).toMatch(/^fc_[A-Za-z0-9]+$/);
		expect(functionCall.call_id).toBe("call_gemini_test_12345");
		expect(functionCall.name).toBe("eval");
		expect(JSON.parse(functionCall.arguments)).toEqual({ code: 'console.log("hello");' });
	});

	it("defensively synthesizes an fc_ id when the tool call item ID is missing or unprefixed", () => {
		const targetModel = createMockCommandCodeModel();

		const bareCallId = "call_bare_without_item_id";
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: bareCallId,
					name: "read",
					arguments: { path: "package.json" },
				},
			],
			api: "openai-completions",
			provider: "custom-legacy",
			model: "legacy-v1",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now() - 2000,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: bareCallId,
			toolName: "read",
			content: [{ type: "text", text: "{}" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "Read package.json", timestamp: Date.now() - 3000 },
				assistant,
				toolResult,
			],
		});

		const allowedProviders = new Set(["openai", "chatgpt-subscription", "opencode"]);
		const input = convertResponsesMessages(targetModel, context, allowedProviders);

		const functionCall = input.find((item) => item.type === "function_call");
		expect(functionCall).toBeDefined();
		if (functionCall?.type !== "function_call") {
			throw new Error("Expected function_call item");
		}

		expect(functionCall.id).toBe(`fc_${shortHash(bareCallId)}`);
		expect(functionCall.call_id).toBe(bareCallId);
	});

	it("drops foreign reasoning items across model switches to prevent payload corruption", () => {
		const targetModel = createMockCommandCodeModel();

		const foreignAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({
						id: "item_foreign_12345",
						status: "completed",
						summary: [{ type: "summary_text", text: "Foreign reasoning text" }],
						type: "reasoning",
					}),
				},
				{
					type: "text",
					text: "Final response",
				},
			],
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			model: "gpt-6-luna",
			usage,
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		};

		const context = normalizeContext({
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() - 2000 }, foreignAssistant],
		});

		const allowedProviders = new Set(["openai", "chatgpt-subscription", "opencode"]);
		const input = convertResponsesMessages(targetModel, context, allowedProviders);

		const reasoningItem = input.find((item) => item.type === "reasoning");
		expect(reasoningItem).toBeUndefined();

		const messageItem = input.find((item) => item.type === "message");
		expect(messageItem).toBeDefined();
	});
});
