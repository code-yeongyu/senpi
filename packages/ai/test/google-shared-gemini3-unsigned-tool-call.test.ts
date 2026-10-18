import { describe, expect, it } from "vitest";
import { convertMessages, requiresToolCallId } from "../src/api/google-shared.ts";
import type { AssistantMessage, Context, ImageContent, Model, TextContent, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Gemini 3+ strictly validates replayed tool calls: the first functionCall part of every step
// in the current turn must carry the thoughtSignature the model returned, or Vertex/AI Studio
// answer 400 "Function call is missing a thought_signature in functionCall parts". The
// skip_thought_signature_validator escape hatch is rejected by Vertex (pi-mono #4032), so a
// current-turn step whose first call carries no usable signature is replayed as text (call + paired result).
// History recorded by a different provider, replayed after a mid-session model switch.

function makeGemini3Model<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id = "gemini-3-pro-preview",
	input: ("text" | "image")[] = ["text"],
): Model<TApi> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const VALID_SIG = "AAAAAAAAAAAAAAAAAAAAAA==";

function makeContext(
	model: { api: string; provider: string; id: string },
	thoughtSignature?: string,
	firstResultIsError = false,
): Context {
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
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: firstResultIsError,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "bash",
				content: [{ type: "text", text: "files" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

const FOREIGN_MODEL = { api: "openai-completions", provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" };

function makeAssistantToolCall(
	model: { api: string; provider: string; id: string },
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp: Date.now(),
	};
}

function makeToolResult(
	toolCallId: string,
	toolName: string,
	content: Array<TextContent | ImageContent>,
	isError = false,
): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content, isError, timestamp: Date.now() };
}

const FAKE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	it.each([
		makeGemini3Model("google-generative-ai", "google"),
		makeGemini3Model("google-generative-ai", "google", "gemini-3.6-flash"),
		makeGemini3Model("google-vertex", "google-vertex"),
	])("preserves tool call IDs for $id via $api history", (model) => {
		const context = makeContext(model, VALID_SIG);
		const contents = convertMessages(model, normalizeContext(context));
		const functionCallIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionCall?.id ? [part.functionCall.id] : []));
		const functionResponseIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionResponse?.id ? [part.functionResponse.id] : []));

		expect(functionCallIds).toEqual(["call_1", "call_2"]);
		expect(functionResponseIds).toEqual(["call_1", "call_2"]);
	});

	it("replays unsigned tool calls and their results as text for Vertex Gemini 3", () => {
		// Given: history recorded on another provider (the reported mid-session model switch).
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext({ api: "openai-completions", provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" }),
			),
		);

		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		const callParts = contents[1]?.parts ?? [];
		expect(callParts).toHaveLength(2);
		expect(callParts.every((part) => part.functionCall === undefined)).toBe(true);
		expect(callParts[0]?.text).toBe('[Tool Call: bash (id: call_1)]\nArguments: {\n  "command": "echo hi"\n}');
		expect(callParts[1]?.text).toContain("[Tool Call: bash (id: call_2)]");
		expect(callParts[1]?.text).toContain('"command": "ls -la"');
		const resultParts = contents[2]?.parts ?? [];
		expect(resultParts).toHaveLength(2);
		expect(resultParts.every((part) => part.functionResponse === undefined)).toBe(true);
		expect(resultParts[0]?.text).toBe("[Tool Result: bash (id: call_1)]\nhi");
		expect(resultParts[1]?.text).toBe("[Tool Result: bash (id: call_2)]\nfiles");
		expect(JSON.stringify(contents)).not.toContain("skip_thought_signature_validator");
	});

	it("replays same-model unsigned tool calls as text too", () => {
		// A same-model turn the API answered without a signature cannot be replayed structured either.
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(model, normalizeContext(makeContext(model)));

		const parts = contents.flatMap((content) => content.parts ?? []);
		expect(parts.some((part) => part.functionCall !== undefined)).toBe(false);
		expect(parts.some((part) => part.functionResponse !== undefined)).toBe(false);
		expect(parts.filter((part) => part.text?.startsWith("[Tool Call: bash (id: call_"))).toHaveLength(2);
		expect(parts.filter((part) => part.text?.startsWith("[Tool Result: bash (id: call_"))).toHaveLength(2);
	});

	it("marks an errored text-replayed tool result", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext(
					{ api: "openai-completions", provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
					undefined,
					true,
				),
			),
		);

		const resultParts = contents[2]?.parts ?? [];
		expect(resultParts[0]?.text).toBe("[Tool Result: bash (id: call_1)] (error)\nhi");
	});

	it("keeps a step structured when its first tool call carries a valid signature", () => {
		// Parallel calls of one response legitimately carry the signature on the first part only.
		const model = makeGemini3Model("google-generative-ai", "google");
		const contents = convertMessages(model, normalizeContext(makeContext(model, VALID_SIG)));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe(VALID_SIG);
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
	});

	it("downgrades step to text when the signature is only on a later call", () => {
		// Strict validation requires signature on the FIRST call; a signature only on
		// subsequent calls cannot prevent the 400 rejection.
		const model = makeGemini3Model("google-generative-ai", "google");
		const context: Context = {
			messages: [
				{ role: "user", content: "run commands", timestamp: Date.now() },
				makeAssistantToolCall(model, [
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "first" } },
					{
						type: "toolCall",
						id: "call_2",
						name: "bash",
						arguments: { command: "second" },
						thoughtSignature: VALID_SIG,
					},
				]),
				makeToolResult("call_1", "bash", [{ type: "text", text: "result 1" }]),
				makeToolResult("call_2", "bash", [{ type: "text", text: "result 2" }]),
			],
		};

		const contents = convertMessages(model, normalizeContext(context));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCalls = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];
		expect(functionCalls).toHaveLength(0);
		expect(modelTurn?.parts?.[0]?.text).toContain("[Tool Call: bash (id: call_1)]");
		expect(modelTurn?.parts?.[1]?.text).toContain("[Tool Call: bash (id: call_2)]");

		const userTurn = contents[2];
		expect(userTurn?.parts?.[0]?.text).toBe("[Tool Result: bash (id: call_1)]\nresult 1");
		expect(userTurn?.parts?.[1]?.text).toBe("[Tool Result: bash (id: call_2)]\nresult 2");
	});

	it("preserves structured replay for earlier turns and only downgrades current turn", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const context: Context = {
			messages: [
				// Turn 1 (earlier)
				{ role: "user", content: "turn 1 prompt", timestamp: Date.now() },
				makeAssistantToolCall(FOREIGN_MODEL, [
					{ type: "toolCall", id: "call_old", name: "bash", arguments: { command: "echo old" } },
				]),
				makeToolResult("call_old", "bash", [{ type: "text", text: "old output" }]),
				// Turn 2 (current turn)
				{ role: "user", content: "turn 2 prompt", timestamp: Date.now() },
				makeAssistantToolCall(FOREIGN_MODEL, [
					{ type: "toolCall", id: "call_new", name: "bash", arguments: { command: "echo new" } },
				]),
				makeToolResult("call_new", "bash", [{ type: "text", text: "new output" }]),
			],
		};

		const contents = convertMessages(model, normalizeContext(context));
		// Turn 1 model turn: should be structured functionCall
		const oldModelTurn = contents[1];
		expect(oldModelTurn?.role).toBe("model");
		expect(oldModelTurn?.parts?.[0]?.functionCall).toEqual({
			name: "bash",
			args: { command: "echo old" },
			id: "call_old",
		});

		// Turn 1 user tool response: should be structured functionResponse
		const oldUserTurn = contents[2];
		expect(oldUserTurn?.role).toBe("user");
		expect(oldUserTurn?.parts?.[0]?.functionResponse).toEqual({
			name: "bash",
			response: { output: "old output" },
			id: "call_old",
		});

		// Turn 2 model turn: current turn unsigned -> downgraded to text
		const newModelTurn = contents[3];
		expect(newModelTurn?.role).toBe("model");
		expect(newModelTurn?.parts?.[0]?.functionCall).toBeUndefined();
		expect(newModelTurn?.parts?.[0]?.text).toBe(
			'[Tool Call: bash (id: call_new)]\nArguments: {\n  "command": "echo new"\n}',
		);

		// Turn 2 user tool response: paired text
		const newUserTurn = contents[4];
		expect(newUserTurn?.role).toBe("user");
		expect(newUserTurn?.parts?.[0]?.functionResponse).toBeUndefined();
		expect(newUserTurn?.parts?.[0]?.text).toBe("[Tool Result: bash (id: call_new)]\nnew output");
	});

	it("treats an image-only user message as the turn boundary", () => {
		// A pasted screenshot with no caption still starts a new turn: the assistant step
		// after it is current-turn and needs signature-safe text replay.
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-3-pro-preview", ["text", "image"]);
		const context: Context = {
			messages: [
				{ role: "user", content: "look at this", timestamp: Date.now() },
				makeAssistantToolCall(FOREIGN_MODEL, [
					{ type: "toolCall", id: "call_old", name: "bash", arguments: { command: "echo old" } },
				]),
				makeToolResult("call_old", "bash", [{ type: "text", text: "old output" }]),
				{
					role: "user",
					content: [{ type: "image", mimeType: "image/png", data: FAKE_PNG }],
					timestamp: Date.now(),
				},
				makeAssistantToolCall(FOREIGN_MODEL, [
					{ type: "toolCall", id: "call_new", name: "bash", arguments: { command: "echo new" } },
				]),
				makeToolResult("call_new", "bash", [{ type: "text", text: "new output" }]),
			],
		};

		const contents = convertMessages(model, normalizeContext(context));
		// The step before the image message is history and stays structured; the image
		// folds into the tool-result user turn right after it.
		expect(contents[1]?.parts?.[0]?.functionCall?.id).toBe("call_old");
		const currentStep = contents[3];
		expect(currentStep?.role).toBe("model");
		expect(currentStep?.parts?.[0]?.functionCall).toBeUndefined();
		expect(currentStep?.parts?.[0]?.text).toBe(
			'[Tool Call: bash (id: call_new)]\nArguments: {\n  "command": "echo new"\n}',
		);
		const currentResult = contents[4];
		expect(currentResult?.role).toBe("user");
		expect(currentResult?.parts?.[0]?.functionResponse).toBeUndefined();
		expect(currentResult?.parts?.[0]?.text).toBe("[Tool Result: bash (id: call_new)]\nnew output");
	});

	it("ignores an empty user message when locating the turn boundary", () => {
		// An empty user turn carries no content and must not become the boundary: the
		// unsigned assistant step before it stays in the current turn and replays as text.
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const context: Context = {
			messages: [
				{ role: "user", content: "run commands", timestamp: Date.now() },
				makeAssistantToolCall(FOREIGN_MODEL, [
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "first" } },
				]),
				makeToolResult("call_1", "bash", [{ type: "text", text: "result 1" }]),
				{ role: "user", content: [{ type: "text", text: "   " }], timestamp: Date.now() },
			],
		};

		const contents = convertMessages(model, normalizeContext(context));
		const modelTurn = contents.find((content) => content.role === "model");
		expect(modelTurn?.parts?.[0]?.functionCall).toBeUndefined();
		expect(modelTurn?.parts?.[0]?.text).toContain("[Tool Call: bash (id: call_1)]");
	});

	it("appends inlineData image parts for image-only tool results in text replay", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-3-pro-preview", ["text", "image"]);
		const context: Context = {
			messages: [
				{ role: "user", content: "read image", timestamp: Date.now() },
				makeAssistantToolCall(FOREIGN_MODEL, [
					{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "img.png" } },
				]),
				makeToolResult("call_img", "read", [{ type: "image", mimeType: "image/png", data: FAKE_PNG }]),
			],
		};

		const contents = convertMessages(model, normalizeContext(context));
		const resultTurn = contents[2];
		expect(resultTurn?.role).toBe("user");
		expect(resultTurn?.parts).toHaveLength(2);
		expect(resultTurn?.parts?.[0]?.text).toBe("[Tool Result: read (id: call_img)]");
		expect(resultTurn?.parts?.[1]?.inlineData).toEqual({
			mimeType: "image/png",
			data: FAKE_PNG,
		});
	});

	it("appends inlineData image parts for text+image tool results in text replay", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-3-pro-preview", ["text", "image"]);
		const context: Context = {
			messages: [
				{ role: "user", content: "read file", timestamp: Date.now() },
				makeAssistantToolCall(FOREIGN_MODEL, [
					{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "img.png" } },
				]),
				makeToolResult("call_img", "read", [
					{ type: "text", text: "here is the image" },
					{ type: "image", mimeType: "image/png", data: FAKE_PNG },
				]),
			],
		};

		const contents = convertMessages(model, normalizeContext(context));
		const resultTurn = contents[2];
		expect(resultTurn?.role).toBe("user");
		expect(resultTurn?.parts).toHaveLength(2);
		expect(resultTurn?.parts?.[0]?.text).toBe("[Tool Result: read (id: call_img)]\nhere is the image");
		expect(resultTurn?.parts?.[1]?.inlineData).toEqual({
			mimeType: "image/png",
			data: FAKE_PNG,
		});
	});

	it("keeps the transform-layer tool-image placeholder for non-vision models", () => {
		// transform-messages.ts replaces tool images with placeholder text before the
		// converter runs, so the text replay emits that placeholder and no inlineData.
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-3-pro-preview", ["text"]);
		const context: Context = {
			messages: [
				{ role: "user", content: "read file", timestamp: Date.now() },
				makeAssistantToolCall(FOREIGN_MODEL, [
					{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "img.png" } },
				]),
				makeToolResult("call_img", "read", [{ type: "image", mimeType: "image/png", data: FAKE_PNG }]),
			],
		};

		const contents = convertMessages(model, normalizeContext(context));
		const resultTurn = contents[2];
		expect(resultTurn?.role).toBe("user");
		expect(resultTurn?.parts).toHaveLength(1);
		expect(resultTurn?.parts?.[0]?.text).toBe(
			"[Tool Result: read (id: call_img)]\n(tool image omitted: model does not support images)",
		);
		expect(resultTurn?.parts?.[0]?.inlineData).toBeUndefined();
	});

	it("omits standalone same-model thinking replay when thinking is off", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const previousAssistant = makeAssistantToolCall(
			model,
			[
				{
					type: "thinking",
					thinking: "prior Google thinking",
					thinkingSignature: "AAAAAAAAAAAAAAAAAAAAAA==",
				},
				{ type: "text", text: "previous answer", textSignature: "BBBBBBBBBBBBBBBBBBBBBB==" },
			],
			"stop",
		);
		const contents = convertMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "first turn", timestamp: Date.now() },
					previousAssistant,
					{ role: "user", content: "follow-up", timestamp: Date.now() },
				],
			}),
			{ preserveThinking: false },
		);
		const modelTurn = contents.find((content) => content.role === "model");

		expect(modelTurn?.parts).toEqual([{ text: "previous answer" }]);
	});

	it("does not replay unsigned tool calls as text for non-Gemini-3 models", () => {
		const model = makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, normalizeContext(makeContext({ ...model, id: "other-model" })));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((part) => part.functionCall !== undefined) ?? [];
		const functionResponseParts = contents
			.flatMap((content) => content.parts ?? [])
			.filter((part) => part.functionResponse !== undefined);

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts.every((part) => part.functionCall?.id === undefined)).toBe(true);
		expect(functionCallParts.every((part) => part.thoughtSignature === undefined)).toBe(true);
		expect(functionResponseParts).toHaveLength(2);
		expect(functionResponseParts.every((part) => part.functionResponse?.id === undefined)).toBe(true);
	});
});

describe("requiresToolCallId", () => {
	it.each([
		[false, "gemini-2.5-flash"],
		[true, "gemini-3.6-flash"],
		[true, "claude-sonnet-4-5"],
		[true, "gpt-oss-120b"],
	] as const)("returns %s for %s", (expected, modelId) => {
		expect(requiresToolCallId(modelId)).toBe(expected);
	});
});
