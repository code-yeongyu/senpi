import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type {
	AuthGatewayProviderRuntime,
	AuthGatewayProviderRuntimeCall,
	AuthGatewayProviderRuntimeResult,
} from "../../src/core/auth-gateway-provider-runtime.ts";
import { createAuthGatewayResponsesPiAdapter } from "../../src/core/auth-gateway-responses-pi-adapter.ts";

describe("auth gateway Responses and Pi adapters", () => {
	it("matches Responses chaining and Pi stream canonical fixtures", async () => {
		// Given: a deterministic runtime and a completed Responses turn followed by a chained turn.
		const runtime = new FixtureRuntime([
			textStream("first", "resp_upstream_1"),
			thinkingToolTextStream("consider", "lookup", '{"query":"senpi"}', "second", "resp_upstream_2"),
			textStream("pi", "resp_upstream_3"),
		]);
		const adapter = createAuthGatewayResponsesPiAdapter({ runtime });

		// When: the Responses client chains from the first response and a Pi-native client asks for SSE.
		const first = await adapter.responses({
			body: { input: "first prompt", model: "gateway-model", stream: false },
		});
		expect(first.kind).toBe("json");
		if (first.kind !== "json") throw new Error("Expected JSON response");
		const firstId = readResponseId(first.body);
		const second = await adapter.responses({
			body: {
				input: "second prompt",
				model: "gateway-model",
				previous_response_id: firstId,
				prompt_cache_key: "cache-key",
				stream: true,
			},
		});
		const pi = await adapter.pi({
			body: {
				context: { messages: [{ content: "pi prompt", role: "user", timestamp: 1 }] },
				modelId: "gateway-model",
				stream: true,
			},
		});

		// Then: chaining preserves prior context/cache identity and both protocols expose their canonical events.
		expect(second.kind).toBe("stream");
		if (second.kind !== "stream") throw new Error("Expected Responses stream");
		expect(await collectFrames(second.frames)).toEqual([
			{
				response: { id: expect.any(String), model: "gateway-model", status: "in_progress" },
				type: "response.created",
			},
			{ delta: "consider", type: "response.reasoning_summary_text.delta" },
			{ delta: '{"query":"senpi"}', type: "response.function_call_arguments.delta" },
			{ delta: "second", type: "response.output_text.delta" },
			{
				response: { id: expect.any(String), model: "gateway-model", status: "completed" },
				type: "response.completed",
			},
			"[DONE]",
		]);
		expect(pi.kind).toBe("stream");
		if (pi.kind !== "stream") throw new Error("Expected Pi stream");
		expect(await collectFrames(pi.frames)).toEqual([
			{ type: "start", partial: expect.any(Object) },
			{ type: "text_start", contentIndex: 0, partial: expect.any(Object) },
			{ type: "text_delta", contentIndex: 0, delta: "pi", partial: expect.any(Object) },
			{ type: "text_end", contentIndex: 0, content: "pi", partial: expect.any(Object) },
			{ type: "done", reason: "stop", message: expect.any(Object) },
			"[DONE]",
		]);
		expect(runtime.calls).toHaveLength(3);
		expect(runtime.calls[1]?.context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(runtime.calls[1]?.streamOptions?.sessionId).toBe("cache-key");
	});

	it("aborts disconnected stream and emits safe terminal error frame", async () => {
		// Given: a request signal that disconnects before the runtime can start and a failing stream.
		const controller = new AbortController();
		const runtime = new FixtureRuntime([errorStream("provider-secret")]);
		const adapter = createAuthGatewayResponsesPiAdapter({ runtime });
		controller.abort();

		// When: a Pi-native request is disconnected and a Responses stream reports a provider failure.
		const aborted = await adapter.pi({
			body: {
				context: { messages: [{ content: "stop", role: "user", timestamp: 1 }] },
				modelId: "gateway-model",
				stream: true,
			},
			signal: controller.signal,
		});
		const failed = await adapter.responses({ body: { input: "fail", model: "gateway-model", stream: true } });

		// Then: disconnect cancellation reaches the runtime and terminal frames never reveal provider details.
		expect(aborted).toEqual({
			body: { error: { message: "client closed request", type: "request_aborted" } },
			kind: "json",
			statusCode: 499,
		});
		expect(failed.kind).toBe("stream");
		if (failed.kind !== "stream") throw new Error("Expected Responses stream");
		const frames = await collectFrames(failed.frames);
		expect(frames[frames.length - 2]).toEqual({
			error: { message: "gateway provider request failed", type: "server_error" },
			type: "error",
		});
		expect(JSON.stringify(frames)).not.toContain("provider-secret");
	});
});

class FixtureRuntime implements AuthGatewayProviderRuntime {
	readonly calls: AuthGatewayProviderRuntimeCall[] = [];
	private readonly streams: AssistantMessageEventStream[];

	constructor(streams: AssistantMessageEventStream[]) {
		this.streams = streams;
	}

	async stream(call: AuthGatewayProviderRuntimeCall): Promise<AuthGatewayProviderRuntimeResult> {
		this.calls.push(call);
		if (call.signal?.aborted) return { kind: "aborted", statusCode: 499 };
		const stream = this.streams.shift();
		if (stream === undefined) throw new Error("Fixture stream exhausted");
		return { kind: "stream", leaseId: "lease-test", model: model(), stream };
	}

	close(): void {}
}

function textStream(text: string, responseId: string): AssistantMessageEventStream {
	return eventStream([
		{ type: "start", partial: message([], responseId) },
		{ type: "text_start", contentIndex: 0, partial: message([], responseId) },
		{ type: "text_delta", contentIndex: 0, delta: text, partial: message([], responseId) },
		{ type: "text_end", contentIndex: 0, content: text, partial: message([], responseId) },
		{ type: "done", reason: "stop", message: message([{ type: "text", text }], responseId) },
	]);
}

function thinkingToolTextStream(
	thinking: string,
	toolName: string,
	argumentsText: string,
	text: string,
	responseId: string,
): AssistantMessageEventStream {
	const argumentsValue = { query: "senpi" };
	return eventStream([
		{ type: "start", partial: message([], responseId) },
		{ type: "thinking_start", contentIndex: 0, partial: message([], responseId) },
		{ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: message([], responseId) },
		{ type: "thinking_end", contentIndex: 0, content: thinking, partial: message([], responseId) },
		{ type: "toolcall_start", contentIndex: 1, partial: message([], responseId) },
		{ type: "toolcall_delta", contentIndex: 1, delta: argumentsText, partial: message([], responseId) },
		{
			type: "toolcall_end",
			contentIndex: 1,
			partial: message([], responseId),
			toolCall: {
				arguments: argumentsValue,
				id: "call_1",
				name: toolName,
				type: "toolCall",
			},
		},
		{ type: "text_start", contentIndex: 2, partial: message([], responseId) },
		{ type: "text_delta", contentIndex: 2, delta: text, partial: message([], responseId) },
		{ type: "text_end", contentIndex: 2, content: text, partial: message([], responseId) },
		{
			type: "done",
			reason: "stop",
			message: message(
				[
					{ type: "thinking", thinking },
					{
						arguments: argumentsValue,
						id: "call_1",
						name: toolName,
						type: "toolCall",
					},
					{ type: "text", text },
				],
				responseId,
			),
		},
	]);
}

function errorStream(detail: string): AssistantMessageEventStream {
	return eventStream([
		{
			type: "error",
			reason: "error",
			error: { ...message([], "resp_error"), errorMessage: detail, stopReason: "error" },
		},
	]);
}

function eventStream(events: readonly AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	for (const event of events) stream.push(event);
	stream.end();
	return stream;
}

function message(content: AssistantMessage["content"], responseId: string): AssistantMessage {
	return {
		api: "gateway-faux",
		content,
		model: "gateway-model",
		provider: "gateway-provider",
		responseId,
		role: "assistant",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			cacheRead: 0,
			cacheWrite: 0,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
			input: 0,
			output: 0,
			totalTokens: 0,
		},
	};
}

function model(): Model<string> {
	return {
		api: "gateway-faux",
		baseUrl: "http://gateway.invalid/v1",
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		contextWindow: 1_000,
		id: "gateway-model",
		input: ["text"],
		maxTokens: 100,
		name: "Gateway model",
		provider: "gateway-provider",
		reasoning: false,
	};
}

async function collectFrames(frames: AsyncIterable<unknown>): Promise<unknown[]> {
	const collected: unknown[] = [];
	for await (const frame of frames) collected.push(frame);
	return collected;
}

function readResponseId(body: unknown): string {
	if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
		throw new Error("Expected Responses id");
	}
	return body.id;
}
