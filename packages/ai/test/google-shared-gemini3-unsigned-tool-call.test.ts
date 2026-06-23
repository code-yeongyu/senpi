import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/google-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

function makeGemini3Model<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id = "gemini-3-pro-preview",
): Model<TApi> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(model: { api: string; provider: string; id: string }, thoughtSignature?: string): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "echo hi" },
						...(thoughtSignature && { thoughtSignature }),
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "bash",
						arguments: { command: "ls -la" },
					},
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: now,
			},
		],
	};
}

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	it("does not add skip_thought_signature_validator for unsigned Google Gen AI tool calls", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const contents = convertMessages(model, makeContext({ ...model, id: "other-model" }));

		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn).toBeTruthy();

		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];
		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBeUndefined();
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(modelTurn)).not.toContain("skip_thought_signature_validator");

		const textParts = modelTurn?.parts?.filter((p) => p.text !== undefined) ?? [];
		const historicalText = textParts.filter((p) => p.text?.includes("Historical context"));
		expect(historicalText).toHaveLength(0);
	});

	it("does not add skip_thought_signature_validator for unsigned Vertex tool calls", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(model, makeContext(model));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBeUndefined();
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(modelTurn)).not.toContain("skip_thought_signature_validator");
	});

	it("preserves valid thoughtSignature when present for the same provider and model", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const contents = convertMessages(model, makeContext(model, validSig));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe(validSig);
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
	});

	it("omits standalone same-model thinking replay when thinking is off", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const previousAssistant: AssistantMessage = {
			role: "assistant",
			api: "google-generative-ai",
			provider: "google",
			model: model.id,
			content: [
				{
					type: "thinking",
					thinking: "prior Google thinking",
					thinkingSignature: "AAAAAAAAAAAAAAAAAAAAAA==",
				},
				{ type: "text", text: "previous answer", textSignature: "BBBBBBBBBBBBBBBBBBBBBB==" },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const contents = convertMessages(
			model,
			{
				messages: [
					{ role: "user", content: "first turn", timestamp: Date.now() },
					previousAssistant,
					{ role: "user", content: "follow-up", timestamp: Date.now() },
				],
			},
			{ preserveThinking: false },
		);
		const modelTurn = contents.find((content) => content.role === "model");

		expect(modelTurn?.parts).toEqual([{ text: "previous answer" }]);
	});

	it("does not add a thoughtSignature for non-Gemini-3 models", () => {
		const model = makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, makeContext({ ...model, id: "other-model" }));
		const modelTurn = contents.find((c) => c.role === "model");
		const fcPart = modelTurn?.parts?.find((p) => p.functionCall !== undefined);

		expect(fcPart).toBeTruthy();
		expect(fcPart?.thoughtSignature).toBeUndefined();
	});
});
