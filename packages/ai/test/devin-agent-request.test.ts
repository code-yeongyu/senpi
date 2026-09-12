import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { GetChatMessageRequestSchema } from "../src/api/devin-agent/gen/cascade_pb.ts";
import {
	buildDevinChatRequest,
	buildDevinRouterPrompt,
	DEVIN_DEFAULT_STOP_PATTERNS,
} from "../src/api/devin-agent/wire.ts";
import type { Context, Model } from "../src/types.ts";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MODEL: Model<"devin-agent"> = {
	id: "swe-1-6",
	name: "SWE-1.6",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 128_000,
} as unknown as Model<"devin-agent">;

function context(): Context {
	return {
		systemPrompt: "You are senpi.\n\nBe precise.",
		messages: [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "considering", thinkingSignature: "sig-1" },
					{ type: "text", text: "hi" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
			},
		],
		tools: [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		],
	} as unknown as Context;
}

describe("devin-agent chat request", () => {
	it("flattens the system prompt and orders history with Cascade roles", () => {
		const request = buildDevinChatRequest({
			model: MODEL,
			context: context(),
			apiKey: "abc",
			userJwt: "jwt-1",
			cascadeId: "conv-1",
		});
		const decoded = fromBinary(GetChatMessageRequestSchema, toBinary(GetChatMessageRequestSchema, request));

		expect(decoded.prompt).toBe("You are senpi.\n\nBe precise.");
		expect(decoded.chatModelUid).toBe("swe-1-6");
		expect(decoded.chatModelName).toBe("");
		expect(decoded.cascadeId).toBe("conv-1");
		expect(decoded.executionId).toMatch(UUID_SHAPE);
		expect(decoded.metadata?.apiKey).toBe("devin-session-token$abc");
		expect(decoded.metadata?.userJwt).toBe("jwt-1");
		expect(decoded.metadata?.ideName).toBe("devin-cli");
		expect(decoded.chatMessagePrompts.map((p) => p.source)).toEqual([1, 2, 4]);
		expect(decoded.chatMessagePrompts[0]?.prompt).toBe("hello");
		expect(decoded.chatMessagePrompts[1]?.thinking).toBe("considering");
		expect(decoded.chatMessagePrompts[1]?.signature).toBe("");
		expect(decoded.chatMessagePrompts[1]?.toolCalls[0]).toMatchObject({
			id: "call-1",
			name: "read",
			argumentsJson: JSON.stringify({ path: "a.ts" }),
		});
		expect(decoded.chatMessagePrompts[2]).toMatchObject({
			toolCallId: "call-1",
			prompt: "file body",
			toolResultIsError: false,
		});
		expect(decoded.tools[0]).toMatchObject({ name: "read", description: "Read a file", strict: false });
		expect(JSON.parse(decoded.tools[0]?.jsonSchemaString ?? "{}")).toMatchObject({ type: "object" });
		expect(decoded.systemPromptCacheOptions?.type).toBe(1);
		expect(decoded.disableParallelToolCalls).toBe(true);
		expect(decoded.modelAssignmentJwt).toBeUndefined();
	});

	it("mints UUID-shaped message ids that are stable per cascade and index", () => {
		const first = buildDevinChatRequest({ model: MODEL, context: context(), apiKey: "abc", cascadeId: "conv-1" });
		const again = buildDevinChatRequest({ model: MODEL, context: context(), apiKey: "abc", cascadeId: "conv-1" });
		const other = buildDevinChatRequest({ model: MODEL, context: context(), apiKey: "abc", cascadeId: "conv-2" });

		const ids = first.chatMessagePrompts.map((p) => p.messageId);
		expect(ids[0]).toMatch(UUID_SHAPE);
		expect(ids[1]).toMatch(/^bot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(ids[2]).toMatch(UUID_SHAPE);
		expect(again.chatMessagePrompts.map((p) => p.messageId)).toEqual(ids);
		expect(other.chatMessagePrompts.map((p) => p.messageId)).not.toEqual(ids);
		expect(first.executionId).not.toBe(again.executionId);
	});

	it("replays a native Devin assistant turn under its own response id and thinking signature", () => {
		const native: Context = {
			systemPrompt: "sys",
			messages: [
				{ role: "user", content: "hi", timestamp: 0 },
				{
					role: "assistant",
					api: "devin-agent",
					provider: "devin",
					model: "swe-1-6",
					responseId: "msg-native-1",
					content: [
						{ type: "thinking", thinking: "t", thinkingSignature: "sig-native" },
						{ type: "text", text: "yo" },
					],
				},
				{ role: "assistant", content: [] },
			],
		} as unknown as Context;
		const request = buildDevinChatRequest({ model: MODEL, context: native, apiKey: "abc", cascadeId: "conv-1" });
		expect(request.chatMessagePrompts).toHaveLength(2);
		expect(request.chatMessagePrompts[1]).toMatchObject({
			messageId: "msg-native-1",
			signature: "sig-native",
			prompt: "yo",
		});
	});

	it("carries inline images on user prompts and tool results", () => {
		const withImages: Context = {
			systemPrompt: "sys",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "shot",
					content: [{ type: "image", data: "BBBB", mimeType: "image/jpeg" }],
					isError: true,
					timestamp: 0,
				},
			],
		} as unknown as Context;
		const request = buildDevinChatRequest({ model: MODEL, context: withImages, apiKey: "abc", cascadeId: "c" });
		expect(request.chatMessagePrompts[0]?.prompt).toBe("look");
		expect(request.chatMessagePrompts[0]?.images).toEqual([
			expect.objectContaining({ base64Data: "AAAA", mimeType: "image/png" }),
		]);
		expect(request.chatMessagePrompts[1]?.images).toEqual([
			expect.objectContaining({ base64Data: "BBBB", mimeType: "image/jpeg" }),
		]);
		expect(request.chatMessagePrompts[1]?.toolResultIsError).toBe(true);
	});

	it("sends the released CLI completion configuration and never a zero temperature", () => {
		const request = buildDevinChatRequest({ model: MODEL, context: context(), apiKey: "abc", cascadeId: "c" });
		expect(request.configuration).toMatchObject({
			numCompletions: 1n,
			maxTokens: 128_000n,
			maxNewlines: 200n,
			temperature: 0.4,
			firstTemperature: 0.4,
			topK: 50n,
			topP: 1,
			fimEotProbThreshold: 1,
			stopPatterns: [...DEVIN_DEFAULT_STOP_PATTERNS],
		});

		const tuned = buildDevinChatRequest({
			model: MODEL,
			context: context(),
			apiKey: "abc",
			cascadeId: "c",
			maxTokens: 4096,
			temperature: 0,
			topP: 0.9,
			stopSequences: ["END"],
		});
		expect(tuned.configuration?.maxTokens).toBe(4096n);
		expect(tuned.configuration?.temperature).toBeGreaterThan(0);
		expect(tuned.configuration?.firstTemperature).toBe(tuned.configuration?.temperature);
		expect(tuned.configuration?.topP).toBe(0.9);
		expect(tuned.configuration?.stopPatterns).toEqual([...DEVIN_DEFAULT_STOP_PATTERNS, "END"]);
	});

	it("honors the upstream wire id, parallel tool calls and a router assignment", () => {
		const routed = {
			...MODEL,
			id: "adaptive",
			upstreamModelId: "adaptive-wire",
			compat: { modelRouter: true, supportsParallelToolCalls: true },
		} as unknown as Model<"devin-agent">;
		const plain = buildDevinChatRequest({ model: routed, context: context(), apiKey: "abc", cascadeId: "c" });
		expect(plain.chatModelUid).toBe("adaptive-wire");
		expect(plain.disableParallelToolCalls).toBe(false);

		const assigned = buildDevinChatRequest({
			model: routed,
			context: context(),
			apiKey: "abc",
			cascadeId: "c",
			assignment: { modelUid: "claude-sonnet-5-medium", assignmentJwt: "assign-jwt" },
		});
		expect(assigned.chatModelUid).toBe("claude-sonnet-5-medium");
		expect(assigned.modelAssignmentJwt).toBe("assign-jwt");
	});

	it("scores the router on the latest user turn alone, with an empty message id", () => {
		const prompt = buildDevinRouterPrompt(context().messages);
		expect(prompt).toMatchObject({ messageId: "", source: 1, prompt: "hello" });
		expect(buildDevinRouterPrompt([])).toBeUndefined();
	});
});
