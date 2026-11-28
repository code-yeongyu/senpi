import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Model, ToolResultMessage, Usage } from "../src/types.ts";
import { shortHash } from "../src/utils/hash.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
	id: "target",
	provider: "custom-responses",
	api: "openai-responses",
	name: "Target",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};

describe("Responses function-call replay transport", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		{
			name: "same model",
			target: model,
			provider: model.provider,
			sourceModel: model.id,
			id: "call_1|fc_original",
			expectedId: "fc_original",
		},
		{
			name: "same model without item ID",
			target: model,
			provider: model.provider,
			sourceModel: model.id,
			id: "call_1",
			expectedId: expect.stringMatching(/^fc_/),
		},
		{
			name: "same gateway different model",
			target: model,
			provider: model.provider,
			sourceModel: "previous",
			id: "call_1|fc_original",
			expectedId: expect.stringMatching(/^fc_/),
		},
		{
			name: "same gateway different model without item ID",
			target: model,
			provider: model.provider,
			sourceModel: "previous",
			id: "call_1",
			expectedId: expect.stringMatching(/^fc_/),
		},
		{
			name: "native OpenAI different model",
			target: { ...model, provider: "openai", baseUrl: "https://api.openai.com/v1" },
			provider: "openai",
			sourceModel: "previous",
			id: "call_1|fc_original",
			expectedId: undefined,
		},
		{
			name: "foreign provider",
			target: model,
			provider: "foreign",
			sourceModel: "previous",
			id: "call_1|foreign_item",
			expectedId: expect.stringMatching(/^fc_/),
		},
		{
			name: "foreign provider without item ID",
			target: model,
			provider: "foreign",
			sourceModel: "previous",
			id: "call_1",
			expectedId: expect.stringMatching(/^fc_/),
		},
	])(
		"serializes $name without losing tool pairing or readable reasoning",
		async ({ target, provider, sourceModel, id, expectedId }) => {
			let payload: unknown;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				payload = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
			});
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Checked the input.",
						thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_original", summary: [] }),
					},
					{ type: "toolCall", id, name: "read", arguments: { path: "note.txt" } },
				],
				api: "openai-responses",
				provider,
				model: sourceModel,
				usage,
				stopReason: "toolUse",
				timestamp: 1,
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 2,
			};

			await stream(target, normalizeContext({ messages: [assistant, result] }), {
				apiKey: "synthetic-key",
			}).result();

			expect(payload).toEqual(
				expect.objectContaining({
					input: expect.arrayContaining([
						expect.objectContaining({
							type: "function_call",
							call_id: "call_1",
							...(expectedId === undefined ? {} : { id: expectedId }),
						}),
						expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
						expect.objectContaining(
							provider === target.provider && sourceModel === target.id
								? { type: "reasoning", id: "rs_original" }
								: { type: "message", content: [expect.objectContaining({ text: "Checked the input." })] },
						),
					]),
				}),
			);
			if (expectedId === undefined) {
				expect(payload).not.toEqual(
					expect.objectContaining({
						input: expect.arrayContaining([
							expect.objectContaining({ type: "function_call", id: expect.anything() }),
						]),
					}),
				);
			}
		},
	);

	it.each([
		{ name: "same-model bare call", sourceModel: model.id, id: "call_bare" },
		{ name: "different-model call", sourceModel: "previous", id: "call_bare|fc_original" },
		{ name: "different-model ID collision", sourceModel: "previous", id: `call_bare|fc_${shortHash("call_bare")}` },
	])("replays a $name through a gateway requiring item IDs", async ({ sourceModel, id }) => {
		let sentInput: unknown;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const body = JSON.parse(String(init?.body));
			sentInput = body.input;
			const call = body.input.find((item: { type: string }) => item.type === "function_call");
			if (
				typeof call?.id !== "string" ||
				!call.id.startsWith("fc_") ||
				(sourceModel !== model.id && call.id === id.split("|")[1])
			) {
				return Response.json(
					{ error: { message: "function_call id required", type: "invalid_request_error" } },
					{ status: 400 },
				);
			}
			const event = {
				type: "response.completed",
				response: {
					id: "resp_test",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			};
			return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: "note.txt" } }],
			api: model.api,
			provider: model.provider,
			model: sourceModel,
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 2,
		};

		const response = await stream(model, normalizeContext({ messages: [assistant, toolResult] }), {
			apiKey: "synthetic-key",
			maxRetryDelayMs: 0,
		}).result();

		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(sentInput).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "function_call",
					call_id: "call_bare",
					id: expect.stringMatching(/^fc_/),
				}),
				expect.objectContaining({ type: "function_call_output", call_id: "call_bare" }),
			]),
		);
	});

	it.each([
		{ name: "same model", sourceModel: "target", itemId: "fc_original" },
		{ name: "different model", sourceModel: "previous", itemId: undefined },
	])("serializes $name through the Codex SSE transport", async ({ sourceModel, itemId }) => {
		let payload: unknown;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const body = init?.body;
			if (!(body instanceof ArrayBuffer)) throw new Error("Expected compressed Codex request body");
			payload = JSON.parse(zstdDecompressSync(new Uint8Array(body)).toString("utf8"));
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		});
		const codexModel: Model<"openai-codex-responses"> = {
			...model,
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1|fc_original", name: "read", arguments: {} }],
			api: codexModel.api,
			provider: codexModel.provider,
			model: sourceModel,
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const tokenPayload = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "synthetic" },
			}),
		).toString("base64");

		const response = await streamCodex(codexModel, normalizeContext({ messages: [assistant] }), {
			apiKey: `synthetic.${tokenPayload}.synthetic`,
			transport: "sse",
		}).result();

		expect(payload, response.errorMessage).toBeDefined();
		expect(payload).toEqual(
			expect.objectContaining({
				input: expect.arrayContaining([
					expect.objectContaining({
						type: "function_call",
						call_id: "call_1",
						...(itemId === undefined ? {} : { id: itemId }),
					}),
				]),
			}),
		);
		if (itemId === undefined) {
			expect(payload).not.toEqual(
				expect.objectContaining({
					input: expect.arrayContaining([
						expect.objectContaining({ type: "function_call", id: expect.anything() }),
					]),
				}),
			);
		}
	});
});
