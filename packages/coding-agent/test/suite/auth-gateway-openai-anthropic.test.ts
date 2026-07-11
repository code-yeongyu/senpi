import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createAnthropicMessagesGatewayAdapter } from "../../src/core/auth-gateway-anthropic-messages.ts";
import { createOpenAIChatGatewayAdapter } from "../../src/core/auth-gateway-openai-chat.ts";
import type {
	AuthGatewayAdapterInput,
	AuthGatewayAdapterRuntime,
} from "../../src/core/auth-gateway-protocol-adapter.ts";

const COMPATIBILITY_MATRIX = [
	{
		allowlistedHeaders: ["x-auth-broker-credential-id", "x-auth-broker-identity-key"],
		auth: "gateway bearer only",
		inputFields: ["messages", "model", "stream", "temperature", "tools"],
		method: "POST",
		nativePassthrough: "none; canonical Context only",
		nonStreamResult: "chat.completion",
		path: "/v1/chat/completions",
		streamFrames: ["chat.completion.chunk", "[DONE]"],
		terminalError: "OpenAI error object",
		translatedMapping: "OpenAI Chat to Context and AssistantMessage events to Chat chunks",
		unsupportedFieldError: "invalid_request_error",
	},
	{
		allowlistedHeaders: ["x-auth-broker-credential-id", "x-auth-broker-identity-key"],
		auth: "gateway bearer only",
		inputFields: ["max_tokens", "messages", "model", "stream", "system", "tools"],
		method: "POST",
		nativePassthrough: "none; canonical Context only",
		nonStreamResult: "message",
		path: "/v1/messages",
		streamFrames: ["message_start", "content_block_delta", "message_stop"],
		terminalError: "Anthropic error event",
		translatedMapping: "Anthropic Messages to Context and AssistantMessage events to Messages frames",
		unsupportedFieldError: "invalid_request_error",
	},
] as const satisfies readonly {
	readonly allowlistedHeaders: readonly string[];
	readonly auth: string;
	readonly inputFields: readonly string[];
	readonly method: "POST";
	readonly nativePassthrough: string;
	readonly nonStreamResult: string;
	readonly path: "/v1/chat/completions" | "/v1/messages";
	readonly streamFrames: readonly string[];
	readonly terminalError: string;
	readonly translatedMapping: string;
	readonly unsupportedFieldError: "invalid_request_error";
}[];

describe("auth gateway OpenAI Chat and Anthropic Messages adapters", () => {
	it("declares a checked compatibility matrix for both translated endpoints", () => {
		expect(COMPATIBILITY_MATRIX.map((entry) => entry.path)).toEqual(["/v1/chat/completions", "/v1/messages"]);
	});

	it("matches golden non-stream and SSE text tool thinking fixtures", async () => {
		// Given: canonical runtime events for a completion with text, thinking, and a tool call.
		const runtime = createRuntime();
		const openAI = createOpenAIChatGatewayAdapter({ provider: "fixture", runtime });
		const anthropic = createAnthropicMessagesGatewayAdapter({ provider: "fixture", runtime });

		// When: OpenAI requests a non-stream response and Anthropic requests an SSE response.
		const completion = await openAI.handle({
			body: { messages: [{ content: "hello", role: "user" }], model: "fixture-model", stream: false },
		});
		const stream = await anthropic.handle({
			body: {
				max_tokens: 64,
				messages: [{ content: "hello", role: "user" }],
				model: "fixture-model",
				stream: true,
			},
		});

		// Then: both endpoint-native shapes preserve text, thinking, and the tool call.
		expect(completion).toMatchObject({
			body: {
				choices: [
					{
						finish_reason: "tool_calls",
						message: {
							content: "done",
							reasoning_content: "considering",
							tool_calls: [
								{ function: { arguments: '{"value":"ok"}', name: "lookup" }, id: "tool-1", type: "function" },
							],
						},
					},
				],
			},
			kind: "json",
			statusCode: 200,
		});
		expect(stream.kind).toBe("sse");
		if (stream.kind !== "sse") throw new Error("Expected SSE result");
		expect(await collectSse(stream)).toEqual([
			{ data: { message: { content: [], role: "assistant" }, type: "message_start" }, event: "message_start" },
			{
				data: { content_block: { thinking: "", type: "thinking" }, index: 0, type: "content_block_start" },
				event: "content_block_start",
			},
			{
				data: { delta: { thinking: "considering", type: "thinking_delta" }, index: 0, type: "content_block_delta" },
				event: "content_block_delta",
			},
			{ data: { index: 0, type: "content_block_stop" }, event: "content_block_stop" },
			{
				data: { content_block: { text: "", type: "text" }, index: 1, type: "content_block_start" },
				event: "content_block_start",
			},
			{
				data: { delta: { text: "done", type: "text_delta" }, index: 1, type: "content_block_delta" },
				event: "content_block_delta",
			},
			{ data: { index: 1, type: "content_block_stop" }, event: "content_block_stop" },
			{
				data: {
					content_block: { id: "", input: {}, name: "", type: "tool_use" },
					index: 2,
					type: "content_block_start",
				},
				event: "content_block_start",
			},
			{
				data: {
					delta: { partial_json: '{"value":"ok"}', type: "input_json_delta" },
					index: 2,
					type: "content_block_delta",
				},
				event: "content_block_delta",
			},
			{ data: { index: 2, type: "content_block_stop" }, event: "content_block_stop" },
			{
				data: { delta: { stop_reason: "tool_use" }, type: "message_delta", usage: { output_tokens: 0 } },
				event: "message_delta",
			},
			{ data: { type: "message_stop" }, event: "message_stop" },
		]);
	});

	it("rejects unknown model or unsupported field with safe terminal error and never forwards inbound Authorization", async () => {
		// Given: a runtime that records calls and adapters with a known model only.
		const runtime = createRuntime();
		const openAI = createOpenAIChatGatewayAdapter({ provider: "fixture", runtime });
		const anthropic = createAnthropicMessagesGatewayAdapter({ provider: "fixture", runtime });

		// When: unknown-model and unsupported-field requests include a caller Authorization header.
		const unknown = await openAI.handle({
			body: { messages: [{ content: "hello", role: "user" }], model: "missing", stream: false },
			headers: { authorization: "Bearer caller-secret" },
		});
		const unsupported = await anthropic.handle({
			body: {
				max_tokens: 64,
				messages: [{ content: "hello", role: "user" }],
				model: "fixture-model",
				stream: true,
				top_p: 0.5,
			},
			headers: { authorization: "Bearer caller-secret" },
		});

		// Then: failures are endpoint-native, terminal, and caller credentials never reach runtime.
		expect(unknown).toEqual({
			body: { error: { code: "model_not_found", message: "Unknown model", type: "invalid_request_error" } },
			kind: "json",
			statusCode: 404,
		});
		expect(unsupported).toEqual({
			body: { error: { message: "Unsupported field: top_p", type: "invalid_request_error" } },
			kind: "json",
			statusCode: 400,
		});
		expect(runtime.calls).toHaveLength(1);
		expect(JSON.stringify(runtime.calls)).not.toContain("caller-secret");
	});
});

async function collectSse(
	result: Extract<
		Awaited<ReturnType<ReturnType<typeof createAnthropicMessagesGatewayAdapter>["handle"]>>,
		{ readonly kind: "sse" }
	>,
): Promise<readonly { readonly data: unknown; readonly event: string }[]> {
	const frames: Array<{ readonly data: unknown; readonly event: string }> = [];
	for await (const frame of result.frames) frames.push(frame);
	return frames;
}

function createRuntime(): AuthGatewayAdapterRuntime & { readonly calls: AuthGatewayAdapterInput[] } {
	const calls: AuthGatewayAdapterInput[] = [];
	return {
		calls,
		async stream(input) {
			calls.push(input);
			if (input.modelId === "missing") return { kind: "model_not_found", statusCode: 404 };
			return { kind: "stream", leaseId: "lease-fixture", model: { id: input.modelId }, stream: fixtureStream() };
		},
	};
}

function fixtureStream(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = fauxAssistantMessage(
		[fauxThinking("considering"), fauxText("done"), fauxToolCall("lookup", { value: "ok" }, { id: "tool-1" })],
		{ stopReason: "toolUse" },
	);
	stream.push({ type: "start", partial: message });
	stream.push({ contentIndex: 0, partial: message, type: "thinking_start" });
	stream.push({ contentIndex: 0, delta: "considering", partial: message, type: "thinking_delta" });
	stream.push({ content: "considering", contentIndex: 0, partial: message, type: "thinking_end" });
	stream.push({ contentIndex: 1, partial: message, type: "text_start" });
	stream.push({ contentIndex: 1, delta: "done", partial: message, type: "text_delta" });
	stream.push({ content: "done", contentIndex: 1, partial: message, type: "text_end" });
	stream.push({ contentIndex: 2, partial: message, type: "toolcall_start" });
	stream.push({ contentIndex: 2, delta: '{"value":"ok"}', partial: message, type: "toolcall_delta" });
	const toolCall = message.content.find((block) => block.type === "toolCall");
	if (toolCall === undefined || toolCall.type !== "toolCall") throw new Error("Expected fixture tool call");
	stream.push({ contentIndex: 2, partial: message, toolCall, type: "toolcall_end" });
	stream.push({ message, reason: "toolUse", type: "done" });
	return stream;
}
