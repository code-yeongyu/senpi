import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamGoogle } from "../src/providers/google.ts";
import { convertMessages } from "../src/providers/google-shared.ts";
import { streamGoogleVertex } from "../src/providers/google-vertex.ts";
import type { AssistantMessage, Context, ProviderNativeContent } from "../src/types.ts";

const googleGenAiMock = vi.hoisted(() => ({
	streamChunks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				for (const chunk of googleGenAiMock.streamChunks) {
					yield chunk;
				}
			},
		};
	}

	return {
		GoogleGenAI,
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			SAFETY: "SAFETY",
			RECITATION: "RECITATION",
			OTHER: "OTHER",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
		},
		FunctionCallingConfigMode: {
			AUTO: "AUTO",
			NONE: "NONE",
			ANY: "ANY",
		},
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

const now = Date.now();
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: now }],
};

function setProviderNativeStreamChunks(): void {
	googleGenAiMock.streamChunks = [
		{
			responseId: "resp_google_native",
			candidates: [
				{
					content: {
						parts: [
							{ text: "done" },
							{ executableCode: { language: "python", code: "print(1)" } },
							{ codeExecutionResult: { outcome: "OUTCOME_OK", output: "1\n" } },
						],
					},
					groundingMetadata: {
						webSearchQueries: ["gemini code execution"],
						groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
					},
					urlContextMetadata: {
						urlMetadata: [{ retrievedUrl: "https://docs.example.com" }],
					},
				},
			],
		},
		{
			candidates: [
				{
					content: { parts: [] },
					groundingMetadata: {
						webSearchQueries: ["gemini code execution"],
					},
					urlContextMetadata: {
						urlMetadata: [{ retrievedUrl: "https://docs.example.com" }],
					},
					finishReason: "STOP",
				},
			],
			usageMetadata: {
				promptTokenCount: 3,
				candidatesTokenCount: 2,
				totalTokenCount: 5,
			},
		},
	];
}

describe("Google provider-native content blocks", () => {
	it("surfaces executableCode/codeExecutionResult parts and candidate metadata once for google + vertex", async () => {
		setProviderNativeStreamChunks();
		const googleMessage = await streamGoogle(getModel("google", "gemini-2.5-flash"), context, {
			apiKey: "x",
		}).result();

		setProviderNativeStreamChunks();
		const vertexMessage = await streamGoogleVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, {
			apiKey: "x",
		}).result();

		for (const message of [googleMessage, vertexMessage]) {
			const providerNativeBlocks = message.content.filter(
				(block): block is ProviderNativeContent => block.type === "providerNative",
			);

			expect(providerNativeBlocks).toEqual([
				{
					type: "providerNative",
					subtype: "executableCode",
					raw: { executableCode: { language: "python", code: "print(1)" } },
				},
				{
					type: "providerNative",
					subtype: "codeExecutionResult",
					raw: { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1\n" } },
				},
				{
					type: "providerNative",
					subtype: "groundingMetadata",
					raw: {
						webSearchQueries: ["gemini code execution"],
						groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
					},
				},
				{
					type: "providerNative",
					subtype: "urlContextMetadata",
					raw: {
						urlMetadata: [{ retrievedUrl: "https://docs.example.com" }],
					},
				},
			]);
		}
	});

	it("skips providerNative blocks when converting assistant replay messages", () => {
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "kept" },
				{ type: "providerNative", subtype: "executableCode", raw: { executableCode: { code: "print(1)" } } },
				{
					type: "providerNative",
					subtype: "groundingMetadata",
					raw: { webSearchQueries: ["gemini code execution"] },
				},
			],
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-2.5-flash",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		};

		const replay = convertMessages(getModel("google", "gemini-2.5-flash"), {
			messages: [{ role: "user", content: "hello", timestamp: now }, assistantMessage],
		});

		const assistantReplay = replay.find((item) => item.role === "model");
		expect(assistantReplay).toBeTruthy();
		expect(assistantReplay?.parts).toEqual([{ text: "kept" }]);
	});
});
