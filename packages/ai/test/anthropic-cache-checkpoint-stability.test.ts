import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildAnthropicWarmPromptCacheParams, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getBuiltinModel as getModel } from "../src/providers/all.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Context, Model, ToolResultMessage } from "../src/types.ts";

const FIRST_TOOL_USE_ID = "toolu_first";
const SECOND_TOOL_USE_ID = "toolu_second";
const THIRD_TOOL_USE_ID = "toolu_third";

function toolResultMessage(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `${toolCallId} result` }],
		isError: false,
		timestamp: 1,
	};
}

function markedToolResultIds(params: ReturnType<typeof buildAnthropicWarmPromptCacheParams>): string[] {
	const markedIds: string[] = [];
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_result" && block.cache_control !== undefined) {
				markedIds.push(block.tool_use_id);
			}
		}
	}
	return markedIds;
}

function cacheBreakpointCount(params: ReturnType<typeof buildAnthropicWarmPromptCacheParams>): number {
	return JSON.stringify(params).match(/"cache_control"/g)?.length ?? 0;
}

interface CacheMarkerSnapshot {
	readonly toolResultIds: readonly string[];
	readonly breakpointCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function cacheMarkerSnapshot(payload: unknown): CacheMarkerSnapshot {
	const toolResultIds: string[] = [];
	const messages = isRecord(payload) && Array.isArray(payload.messages) ? payload.messages : [];
	for (const message of messages) {
		if (!isRecord(message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (
				isRecord(block) &&
				block.type === "tool_result" &&
				"cache_control" in block &&
				typeof block.tool_use_id === "string"
			) {
				toolResultIds.push(block.tool_use_id);
			}
		}
	}
	return {
		toolResultIds,
		breakpointCount: (JSON.stringify(payload) ?? "").match(/"cache_control"/g)?.length ?? 0,
	};
}

function oauthSseResponse(): Response {
	const events = [
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","usage":{"input_tokens":1,"output_tokens":0}}}\n',
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
		'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n',
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n',
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n',
		'event: message_stop\ndata: {"type":"message_stop"}\n',
	];
	return new Response(events.join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureOAuthCacheMarkers(
	model: Model<"anthropic-messages">,
	context: Context,
	cacheRetention?: "none",
): Promise<CacheMarkerSnapshot> {
	let payload: unknown;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		payload = JSON.parse(String(init?.body));
		return oauthSseResponse();
	};
	const response = streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		fetch,
		...(cacheRetention ? { cacheRetention } : {}),
	});
	await response.result();
	if (payload === undefined) throw new Error("Expected the OAuth request payload");
	return cacheMarkerSnapshot(payload);
}

function oauthToolLoopContexts(systemPrompt?: string): readonly [Context, Context, Context] {
	const firstToolLoop: Context = {
		...(systemPrompt ? { systemPrompt } : {}),
		messages: [
			{ role: "user", content: "Inspect the repository", timestamp: 1 },
			fauxAssistantMessage(fauxToolCall("read", {}, { id: FIRST_TOOL_USE_ID }), { stopReason: "toolUse" }),
			toolResultMessage(FIRST_TOOL_USE_ID),
		],
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({}) }],
	};
	const secondToolLoop: Context = {
		...firstToolLoop,
		messages: [
			...firstToolLoop.messages,
			fauxAssistantMessage(fauxToolCall("read", {}, { id: SECOND_TOOL_USE_ID }), { stopReason: "toolUse" }),
			toolResultMessage(SECOND_TOOL_USE_ID),
		],
	};
	const thirdToolLoop: Context = {
		...secondToolLoop,
		messages: [
			...secondToolLoop.messages,
			fauxAssistantMessage(fauxToolCall("read", {}, { id: THIRD_TOOL_USE_ID }), { stopReason: "toolUse" }),
			toolResultMessage(THIRD_TOOL_USE_ID),
		],
	};
	return [firstToolLoop, secondToolLoop, thirdToolLoop];
}

describe("Anthropic cache checkpoints", () => {
	it("retains the preceding tool-result checkpoint while marking a new tool-result tail", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const firstToolLoop: Context = {
			systemPrompt: "You are concise.",
			messages: [
				{ role: "user", content: "Inspect the repository", timestamp: 1 },
				fauxAssistantMessage(fauxToolCall("read", {}, { id: FIRST_TOOL_USE_ID }), { stopReason: "toolUse" }),
				toolResultMessage(FIRST_TOOL_USE_ID),
			],
			tools: [{ name: "read", description: "Read a file", parameters: Type.Object({}) }],
		};
		const secondToolLoop: Context = {
			...firstToolLoop,
			messages: [
				...firstToolLoop.messages,
				fauxAssistantMessage(fauxToolCall("read", {}, { id: SECOND_TOOL_USE_ID }), { stopReason: "toolUse" }),
				toolResultMessage(SECOND_TOOL_USE_ID),
			],
		};
		const thirdToolLoop: Context = {
			...secondToolLoop,
			messages: [
				...secondToolLoop.messages,
				fauxAssistantMessage(fauxToolCall("read", {}, { id: THIRD_TOOL_USE_ID }), { stopReason: "toolUse" }),
				toolResultMessage(THIRD_TOOL_USE_ID),
			],
		};

		expect(markedToolResultIds(buildAnthropicWarmPromptCacheParams(model, firstToolLoop))).toEqual([
			FIRST_TOOL_USE_ID,
		]);
		expect(markedToolResultIds(buildAnthropicWarmPromptCacheParams(model, secondToolLoop))).toEqual([
			FIRST_TOOL_USE_ID,
			SECOND_TOOL_USE_ID,
		]);
		expect(markedToolResultIds(buildAnthropicWarmPromptCacheParams(model, thirdToolLoop))).toEqual([
			SECOND_TOOL_USE_ID,
			THIRD_TOOL_USE_ID,
		]);
		expect(cacheBreakpointCount(buildAnthropicWarmPromptCacheParams(model, thirdToolLoop))).toBe(4);
	});

	it.each([
		["without", undefined],
		["with", "Keep the response concise."],
	])("retains two rolling OAuth checkpoints %s a context system prompt", async (_label, systemPrompt) => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const [firstToolLoop, secondToolLoop, thirdToolLoop] = oauthToolLoopContexts(systemPrompt);

		expect((await captureOAuthCacheMarkers(model, firstToolLoop)).toolResultIds).toEqual([FIRST_TOOL_USE_ID]);
		expect((await captureOAuthCacheMarkers(model, secondToolLoop)).toolResultIds).toEqual([
			FIRST_TOOL_USE_ID,
			SECOND_TOOL_USE_ID,
		]);
		const thirdSnapshot = await captureOAuthCacheMarkers(model, thirdToolLoop);
		expect(thirdSnapshot.toolResultIds).toEqual([SECOND_TOOL_USE_ID, THIRD_TOOL_USE_ID]);
		expect(thirdSnapshot.breakpointCount).toBe(4);
	});

	it("marks only the OAuth tail when there is no preceding tool-result checkpoint", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const [firstToolLoop] = oauthToolLoopContexts();

		expect((await captureOAuthCacheMarkers(model, firstToolLoop)).toolResultIds).toEqual([FIRST_TOOL_USE_ID]);
	});

	it("omits every OAuth cache marker when cache retention is none", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const [, , thirdToolLoop] = oauthToolLoopContexts("Keep the response concise.");

		expect((await captureOAuthCacheMarkers(model, thirdToolLoop, "none")).breakpointCount).toBe(0);
	});

	it("does not mark an unpaired OAuth tool result", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const [firstToolLoop] = oauthToolLoopContexts();
		const unpairedResultContext: Context = {
			...firstToolLoop,
			messages: [...firstToolLoop.messages, toolResultMessage("toolu_unpaired")],
		};

		expect((await captureOAuthCacheMarkers(model, unpairedResultContext)).toolResultIds).toEqual([]);
	});
});
