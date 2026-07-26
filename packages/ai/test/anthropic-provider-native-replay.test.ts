import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
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
	contextExtras?: { tools?: Context["tools"]; modelCompat?: Model<"anthropic-messages">["compat"] },
): Promise<CapturedAnthropicPayload> {
	let capturedPayload: CapturedAnthropicPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
		// The localhost override only captures the payload; these tests exercise
		// first-party replay semantics rather than endpoint capability detection.
		compat: { ...model.compat, supportsWebSearch: true, ...contextExtras?.modelCompat },
	};
	const stream = streamSimple(
		payloadCaptureModel,
		{ messages, tools: contextExtras?.tools },
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

	// A mixed turn that stops for a client tool can leave `server_tool_use`
	// blocks whose results the API delivers only after the client tool results
	// come back. While only tool results follow, the turn is still resumable, so
	// the pending uses must replay or the API never runs the deferred searches.
	it("keeps pending server_tool_use blocks of a live mixed turn", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const pendingUse = {
			type: "server_tool_use",
			id: "srvtoolu_pending",
			name: "web_search",
			input: { query: "a" },
		};
		const assistant = assistantMessage(
			[
				{ type: "toolCall", id: "toolu_task", name: "task", arguments: { prompt: "go" } },
				{ type: "providerNative", subtype: "server_tool_use", raw: pendingUse },
			],
			{ stopReason: "toolUse", model: "claude-fable-5" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_task",
				toolName: "task",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 2,
			},
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([
			{ type: "tool_use", id: "toolu_task", name: "task", input: { prompt: "go" } },
			pendingUse,
		]);
	});

	// The continuation the API promises for a deferred call: the NEXT assistant
	// message starts with the result that answers the earlier `server_tool_use`.
	// Both halves must replay — the use in the first message, the result in the
	// second.
	it("keeps both halves of a cross-message server-tool continuation", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const pendingUse = {
			type: "server_tool_use",
			id: "srvtoolu_pending",
			name: "web_search",
			input: { query: "a" },
		};
		const continuationResult = {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_pending",
			content: [{ type: "web_search_result", title: "A", url: "https://a.example", encrypted_content: "enc" }],
		};
		const first = assistantMessage(
			[
				{ type: "toolCall", id: "toolu_task", name: "task", arguments: { prompt: "go" } },
				{ type: "providerNative", subtype: "server_tool_use", raw: pendingUse },
			],
			{ stopReason: "toolUse", model: "claude-fable-5" },
		);
		const second = assistantMessage(
			[
				{ type: "providerNative", subtype: "web_search_tool_result", raw: continuationResult },
				{ type: "text", text: "search done" },
			],
			{ stopReason: "stop", model: "claude-fable-5" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			first,
			{
				role: "toolResult",
				toolCallId: "toolu_task",
				toolName: "task",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 2,
			},
			second,
			{ role: "user", content: "follow up", timestamp: 3 },
		]);

		const assistants = (payload.messages ?? []).filter((message) => message.role === "assistant");
		expect(assistants[0]?.content).toEqual([
			{ type: "tool_use", id: "toolu_task", name: "task", input: { prompt: "go" } },
			pendingUse,
		]);
		expect(assistants[1]?.content).toEqual([continuationResult, { type: "text", text: "search done" }]);
	});

	// A user text message after the client tool results tells the API the
	// assistant turn is over, so its `server_tool_use` blocks can never be
	// answered. Replaying them makes every later request fail with
	// `400 ... web_search tool use with id ... was found without a corresponding
	// web_search_tool_result block`, which wedges the session permanently because
	// history only grows. This is the shape of the production wedge.
	it("drops server_tool_use blocks whose turn was closed by a later user message", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const assistant = assistantMessage(
			[
				{ type: "thinking", thinking: "planning", thinkingSignature: "sig_1" },
				{ type: "toolCall", id: "toolu_task", name: "task", arguments: { prompt: "go" } },
				{
					type: "providerNative",
					subtype: "server_tool_use",
					raw: {
						type: "server_tool_use",
						id: "srvtoolu_orphan_1",
						name: "web_search",
						input: { query: "a" },
					},
				},
				{
					type: "providerNative",
					subtype: "server_tool_use",
					raw: {
						type: "server_tool_use",
						id: "srvtoolu_orphan_2",
						name: "web_search",
						input: { query: "b" },
					},
				},
			],
			{ stopReason: "toolUse", model: "claude-fable-5" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_task",
				toolName: "task",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "steering text that closes the turn", timestamp: 3 },
		]);

		const assistantPayload = payload.messages?.find((message) => message.role === "assistant");
		expect(assistantPayload?.content).toEqual([
			{ type: "thinking", thinking: "planning", signature: "sig_1" },
			{ type: "tool_use", id: "toolu_task", name: "task", input: { prompt: "go" } },
		]);
	});

	// A blank user message serializes to nothing, so it cannot close the turn on
	// the wire; the pending use must stay live through it. Real text closes it.
	it("keeps a pending server_tool_use across a blank user message but drops it after real text", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const pendingUse = {
			type: "server_tool_use",
			id: "srvtoolu_pending",
			name: "web_search",
			input: { query: "a" },
		};
		const makeAssistant = () =>
			assistantMessage(
				[
					{ type: "toolCall", id: "toolu_task", name: "task", arguments: { prompt: "go" } },
					{ type: "providerNative", subtype: "server_tool_use", raw: pendingUse },
				],
				{ stopReason: "toolUse", model: "claude-fable-5" },
			);
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "toolu_task",
			toolName: "task",
			content: [{ type: "text" as const, text: "out" }],
			isError: false,
			timestamp: 2,
		};

		const blank = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			makeAssistant(),
			toolResult,
			{ role: "user", content: "   ", timestamp: 3 },
		]);
		const blankAssistant = blank.messages?.find((message) => message.role === "assistant");
		expect(blankAssistant?.content).toContainEqual(pendingUse);

		const closed = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			makeAssistant(),
			toolResult,
			{ role: "user", content: "real steering text", timestamp: 3 },
		]);
		const closedAssistant = closed.messages?.find((message) => message.role === "assistant");
		expect(closedAssistant?.content).not.toContainEqual(pendingUse);
	});

	// A tool result whose added names are NOT deferred emits no sibling text, so
	// the wire turn stays resumable and the pending use must replay. When a name
	// IS deferred, its reference serializes sibling text after the tool_result
	// blocks — text after the results closes the turn and the use must drop.
	it("mirrors the tool-reference wire shape when deciding closure for added tool names", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const pendingUse = {
			type: "server_tool_use",
			id: "srvtoolu_pending",
			name: "web_search",
			input: { query: "a" },
		};
		const makeAssistant = () =>
			assistantMessage(
				[
					{ type: "toolCall", id: "toolu_task", name: "task", arguments: { prompt: "go" } },
					{ type: "providerNative", subtype: "server_tool_use", raw: pendingUse },
				],
				{ stopReason: "toolUse", model: "claude-fable-5" },
			);
		const makeToolResult = () => ({
			role: "toolResult" as const,
			toolCallId: "toolu_task",
			toolName: "task",
			content: [{ type: "text" as const, text: "out" }],
			isError: false,
			addedToolNames: ["deferred_tool"],
			timestamp: 2,
		});
		// An immediate tool must exist alongside, or the deferred set is promoted
		// to immediate wholesale and no reference ever emits.
		const taskTool = {
			name: "task",
			description: "The already-loaded tool.",
			parameters: Type.Object({}),
		};
		const deferredTool = {
			name: "deferred_tool",
			description: "A tool registered by the result.",
			parameters: Type.Object({}),
		};

		// Not deferred (no tool definition registered): plain tool_result, no closure.
		const resumable = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			makeAssistant(),
			makeToolResult(),
		]);
		const resumableAssistant = resumable.messages?.find((message) => message.role === "assistant");
		expect(resumableAssistant?.content).toContainEqual(pendingUse);

		// Deferred: the reference emits sibling text after the result, closing the turn.
		const closed = await capturePayload(
			model,
			[{ role: "user", content: "hello", timestamp: 1 }, makeAssistant(), makeToolResult()],
			undefined,
			{ tools: [taskTool, deferredTool], modelCompat: { supportsToolReferences: true } },
		);
		const closedAssistant = closed.messages?.find((message) => message.role === "assistant");
		expect(closedAssistant?.content).not.toContainEqual(pendingUse);
		const closedUser = (closed.messages ?? []).find(
			(message) => message.role === "user" && Array.isArray(message.content),
		);
		expect(JSON.stringify(closedUser?.content)).toContain("tool_reference");
	});

	// User text between a deferred use and its late result killed the turn before
	// the result could mean anything: both halves are unpairable on replay.
	it("drops both halves when user text intervenes between a use and its late result", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const pendingUse = {
			type: "server_tool_use",
			id: "srvtoolu_pending",
			name: "web_search",
			input: { query: "a" },
		};
		const lateResult = {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_pending",
			content: [{ type: "web_search_result", title: "A", url: "https://a.example", encrypted_content: "enc" }],
		};
		const first = assistantMessage(
			[
				{ type: "toolCall", id: "toolu_task", name: "task", arguments: { prompt: "go" } },
				{ type: "providerNative", subtype: "server_tool_use", raw: pendingUse },
			],
			{ stopReason: "toolUse", model: "claude-fable-5" },
		);
		const second = assistantMessage(
			[
				{ type: "providerNative", subtype: "web_search_tool_result", raw: lateResult },
				{ type: "text", text: "late answer" },
			],
			{ stopReason: "stop", model: "claude-fable-5" },
		);

		const payload = await capturePayload(model, [
			{ role: "user", content: "hello", timestamp: 1 },
			first,
			{
				role: "toolResult",
				toolCallId: "toolu_task",
				toolName: "task",
				content: [{ type: "text", text: "out" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "intervening steering text", timestamp: 3 },
			second,
			{ role: "user", content: "follow up", timestamp: 4 },
		]);

		const assistants = (payload.messages ?? []).filter((message) => message.role === "assistant");
		expect(assistants[0]?.content).toEqual([
			{ type: "tool_use", id: "toolu_task", name: "task", input: { prompt: "go" } },
		]);
		expect(assistants[1]?.content).toEqual([{ type: "text", text: "late answer" }]);
	});

	// A discarded pre-fallback result emits nothing and loads nothing, so a later
	// surviving result with the same deferred name still emits its reference —
	// closing a pending server-tool turn after it.
	it("does not let a discarded fallback result pre-load a deferred tool name", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const pendingUse = {
			type: "server_tool_use",
			id: "srvtoolu_pending",
			name: "web_search",
			input: { query: "a" },
		};
		const fallbackBlock = {
			type: "fallback",
			from: { model: "claude-fable-5" },
			to: { model: "claude-opus-4-8" },
			trigger: { type: "refusal", category: "cyber" },
		};
		const first = assistantMessage(
			[
				{ type: "toolCall", id: "toolu_pre", name: "pre_tool", arguments: {} },
				{ type: "providerNative", subtype: "fallback", raw: fallbackBlock },
				{ type: "thinking", thinking: "served", thinkingSignature: "sig_post" },
			],
			{ stopReason: "stop", model: "claude-fable-5" },
		);
		const second = assistantMessage(
			[
				{ type: "toolCall", id: "toolu_other", name: "other_tool", arguments: {} },
				{ type: "providerNative", subtype: "server_tool_use", raw: pendingUse },
			],
			{ stopReason: "toolUse", model: "claude-fable-5" },
		);
		const tools = [
			{ name: "pre_tool", description: "Used by the discarded call.", parameters: Type.Object({}) },
			{ name: "other_tool", description: "Used by the surviving call.", parameters: Type.Object({}) },
			{ name: "deferred_x", description: "Registered twice.", parameters: Type.Object({}) },
		];

		const payload = await capturePayload(
			model,
			[
				{ role: "user", content: "hello", timestamp: 1 },
				first,
				{
					role: "toolResult",
					toolCallId: "toolu_pre",
					toolName: "pre_tool",
					content: [{ type: "text", text: "discarded" }],
					isError: false,
					addedToolNames: ["deferred_x"],
					timestamp: 2,
				},
				second,
				{
					role: "toolResult",
					toolCallId: "toolu_other",
					toolName: "other_tool",
					content: [{ type: "text", text: "surviving" }],
					isError: false,
					addedToolNames: ["deferred_x"],
					timestamp: 3,
				},
			],
			undefined,
			{ tools, modelCompat: { supportsToolReferences: true } },
		);

		// The surviving result emits the reference (sibling text closes the turn),
		// so the pending use of that turn must drop.
		const assistants = (payload.messages ?? []).filter((message) => message.role === "assistant");
		expect(assistants[1]?.content).toEqual([{ type: "tool_use", id: "toolu_other", name: "other_tool", input: {} }]);
		const users = (payload.messages ?? []).filter((message) => message.role === "user");
		expect(JSON.stringify(users.map((message) => message.content))).toContain("tool_reference");
	});

	// The mirror image: a result block whose `server_tool_use` never made it into
	// the persisted turn is equally unpairable, so it must be dropped while the
	// paired blocks in the same message replay verbatim.
	it("drops a server-tool result whose server_tool_use is missing and keeps the paired one", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const pairedUse = { type: "server_tool_use", id: "srvu_paired", name: "web_search", input: { query: "a" } };
		const pairedResult = {
			type: "web_search_tool_result",
			tool_use_id: "srvu_paired",
			content: [{ type: "web_search_result", title: "A", url: "https://a.example", encrypted_content: "enc" }],
		};
		const orphanResult = {
			type: "web_search_tool_result",
			tool_use_id: "srvu_missing",
			content: [{ type: "web_search_result", title: "B", url: "https://b.example", encrypted_content: "enc" }],
		};
		const assistant = assistantMessage(
			[
				{ type: "providerNative", subtype: "server_tool_use", raw: pairedUse },
				{ type: "providerNative", subtype: "web_search_tool_result", raw: pairedResult },
				{ type: "providerNative", subtype: "web_search_tool_result", raw: orphanResult },
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
		expect(assistantPayload?.content).toEqual([pairedUse, pairedResult, { type: "text", text: "kept" }]);
	});
});
