import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import "../src/providers/register-builtins.ts";
import { streamSimple } from "../src/stream.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface CapturedAnthropicMessage {
	readonly role: string;
	readonly content: unknown;
}

interface CapturedAnthropicPayload {
	readonly messages?: readonly CapturedAnthropicMessage[];
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parsePayload(value: unknown): CapturedAnthropicPayload {
	if (!isRecord(value)) {
		return {};
	}
	const messages = value.messages;
	if (!Array.isArray(messages)) {
		return {};
	}
	return {
		messages: messages.flatMap((message) => {
			if (!isRecord(message) || typeof message.role !== "string") {
				return [];
			}
			return [{ role: message.role, content: message.content }];
		}),
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	overrides?: Partial<AssistantMessage>,
): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		content,
		usage,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	messages: Context["messages"],
	options?: SimpleStreamOptions,
): Promise<CapturedAnthropicPayload> {
	let capturedPayload: CapturedAnthropicPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};
	const stream = streamSimple(
		payloadCaptureModel,
		{ messages },
		{
			...options,
			apiKey: "fake-key",
			onPayload: (payload) => {
				capturedPayload = parsePayload(payload);
				return payload;
			},
		},
	);

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic provider-native replay", () => {
	it("preserves same-model server tool blocks around signed thinking", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const serverToolUse = { type: "server_tool_use", id: "srvu_1", name: "web_search", input: { query: "hi" } };
		const webSearchToolResult = {
			type: "web_search_tool_result",
			tool_use_id: "srvu_1",
			content: [
				{ type: "web_search_result", title: "Example", url: "https://example.com", encrypted_content: "enc" },
			],
		};
		const assistant = assistantMessage(
			[
				{ type: "providerNative", subtype: "server_tool_use", raw: serverToolUse },
				{ type: "providerNative", subtype: "web_search_tool_result", raw: webSearchToolResult },
				{ type: "thinking", thinking: "protected thinking", thinkingSignature: "sig_1" },
				{ type: "text", text: "kept" },
				{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "README.md" } },
			],
			{ stopReason: "toolUse" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: 2,
			},
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([
			serverToolUse,
			{
				type: "web_search_tool_result",
				tool_use_id: "srvu_1",
				content: [
					{
						type: "web_search_result",
						title: "Example",
						url: "https://example.com",
						encrypted_content: "enc",
					},
				],
			},
			{ type: "thinking", thinking: "protected thinking", signature: "sig_1" },
			{ type: "text", text: "kept" },
			{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } },
		]);
	});

	it("keeps the served attempt and the fallback marker, dropping the discarded thinking before it", async () => {
		// Server-side fallback (server-side-fallback-2026-06-01 beta) emits a
		// `fallback` content block mid-response. Blocks *before* the marker belong
		// to the declined attempt; per the replay contract they must be omitted
		// (the marker onward is the serving model's output and replays verbatim).
		// The marker itself is kept as an audit block.
		const model = getModel("anthropic", "claude-fable-5");
		const fallbackBlock = {
			type: "fallback",
			from: { model: "claude-fable-5" },
			to: { model: "claude-opus-4-8" },
			trigger: { type: "refusal", category: null },
		};
		const assistant = assistantMessage(
			[
				{ type: "thinking", thinking: "before fallback", thinkingSignature: "sig_1" },
				{ type: "providerNative", subtype: "fallback", raw: fallbackBlock },
				{ type: "thinking", thinking: "after fallback", thinkingSignature: "sig_2" },
				{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "README.md" } },
			],
			{ stopReason: "toolUse", model: "claude-fable-5" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: 2,
			},
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([
			fallbackBlock,
			{ type: "thinking", thinking: "after fallback", signature: "sig_2" },
			{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "README.md" } },
		]);
	});

	it("drops the discarded attempt's tool_use before a fallback boundary and its orphaned tool_result", async () => {
		// Production 400 (req_011CciJpfp2AxQUwVdt8YhmH): the ccapi server-side-fallback
		// beta emitted a `fallback` block AFTER a tool_use. Replaying the pre-boundary
		// tool_use (from the declined Fable attempt) made the API reject the turn:
		// "tool_use ids were found without tool_result blocks immediately after:
		// toolu_pre". Per server-side-fallback-2026-06-01, blocks before the final
		// fallback marker are the declined attempt and must be dropped — and a dropped
		// tool_use's tool_result must be dropped with it, or it dangles as an orphan.
		const model = getModel("anthropic", "claude-fable-5");
		const fallbackBlock = {
			type: "fallback",
			from: { model: "claude-fable-5" },
			to: { model: "claude-opus-4-8" },
			trigger: { type: "refusal", category: "cyber" },
		};
		const assistant = assistantMessage(
			[
				{ type: "thinking", thinking: "discarded", thinkingSignature: "sig_pre" },
				{ type: "toolCall", id: "toolu_pre", name: "bash", arguments: { command: "echo hi" } },
				{ type: "providerNative", subtype: "fallback", raw: fallbackBlock },
				{ type: "thinking", thinking: "served", thinkingSignature: "sig_post" },
				{ type: "toolCall", id: "toolu_post", name: "read", arguments: { path: "README.md" } },
			],
			{ stopReason: "toolUse", model: "claude-fable-5" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_pre",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_post",
				toolName: "read",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 3,
			},
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([
			fallbackBlock,
			{ type: "thinking", thinking: "served", signature: "sig_post" },
			{ type: "tool_use", id: "toolu_post", name: "read", input: { path: "README.md" } },
		]);

		// The discarded tool_use's tool_result must be gone; the served one stays.
		const toolResultIds: unknown[] = [];
		for (const message of payload.messages ?? []) {
			if (message.role !== "user" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (isRecord(block) && block.type === "tool_result") {
					toolResultIds.push(block.tool_use_id);
				}
			}
		}
		expect(toolResultIds).not.toContain("toolu_pre");
		expect(toolResultIds).toContain("toolu_post");
	});

	it("drops an unpaired server_tool_use before a fallback boundary but keeps a paired one", async () => {
		// Per server-side-fallback-2026-06-01, blocks before the final fallback
		// marker belong to the declined attempt. The replay contract keeps text and
		// *paired* server-tool blocks but omits an unpaired `server_tool_use` — its
		// missing result would otherwise leave it dangling and 400 the turn. Here the
		// declined attempt has one paired search (result present) and one unpaired
		// search (fallback interrupted before its result); only the paired pair may
		// replay.
		const model = getModel("anthropic", "claude-fable-5");
		const pairedUse = { type: "server_tool_use", id: "srvu_paired", name: "web_search", input: { query: "a" } };
		const pairedResult = {
			type: "web_search_tool_result",
			tool_use_id: "srvu_paired",
			content: [{ type: "web_search_result", title: "A", url: "https://a.example", encrypted_content: "enc" }],
		};
		const unpairedUse = { type: "server_tool_use", id: "srvu_unpaired", name: "web_search", input: { query: "b" } };
		const fallbackBlock = {
			type: "fallback",
			from: { model: "claude-fable-5" },
			to: { model: "claude-opus-4-8" },
			trigger: { type: "refusal", category: "cyber" },
		};
		const assistant = assistantMessage(
			[
				{ type: "providerNative", subtype: "server_tool_use", raw: pairedUse },
				{ type: "providerNative", subtype: "web_search_tool_result", raw: pairedResult },
				{ type: "providerNative", subtype: "server_tool_use", raw: unpairedUse },
				{ type: "providerNative", subtype: "fallback", raw: fallbackBlock },
				{ type: "thinking", thinking: "served", thinkingSignature: "sig_post" },
				{ type: "toolCall", id: "toolu_post", name: "read", arguments: { path: "README.md" } },
			],
			{ stopReason: "toolUse", model: "claude-fable-5" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_post",
				toolName: "read",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 2,
			},
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([
			pairedUse,
			{
				type: "web_search_tool_result",
				tool_use_id: "srvu_paired",
				content: [
					{
						type: "web_search_result",
						title: "A",
						url: "https://a.example",
						encrypted_content: "enc",
					},
				],
			},
			fallbackBlock,
			{ type: "thinking", thinking: "served", signature: "sig_post" },
			{ type: "tool_use", id: "toolu_post", name: "read", input: { path: "README.md" } },
		]);
	});

	it("drops same-model provider-native blocks with unknown subtypes", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const assistant = assistantMessage(
			[
				{ type: "providerNative", subtype: "mystery_block", raw: { type: "mystery_block", data: "x" } },
				{ type: "text", text: "kept" },
			],
			{ stopReason: "stop" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "follow up", timestamp: 2 },
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([{ type: "text", text: "kept" }]);
	});

	it("drops fallback blocks from a different model's assistant message", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const assistant = assistantMessage(
			[
				{
					type: "providerNative",
					subtype: "fallback",
					raw: { type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
				},
				{ type: "text", text: "kept" },
			],
			{ stopReason: "stop", model: "claude-fable-5" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "follow up", timestamp: 2 },
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([{ type: "text", text: "kept" }]);
	});

	it("drops cross-provider provider-native blocks", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const assistant = assistantMessage(
			[
				{ type: "providerNative", subtype: "web_search_call", raw: { type: "web_search_call", id: "ws_1" } },
				{ type: "text", text: "kept" },
			],
			{
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.4",
			},
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "follow up", timestamp: 2 },
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([{ type: "text", text: "kept" }]);
	});
});
