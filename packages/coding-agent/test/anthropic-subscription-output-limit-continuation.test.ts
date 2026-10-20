import type { Api, AssistantMessage, Model, Tool } from "@earendil-works/pi-ai";
import { wrapStreamWithModelRecovery } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { RESPONSE_RESTART_DIAGNOSTIC } from "../src/core/extensions/builtin/anthropic-subscription/stream-events.ts";

/**
 * Claude Code's output-limit recovery: when a response stops at the CLI's output cap (`max_tokens`), the CLI
 * appends its "Output token limit hit. Resume directly …" meta prompt and streams a SECOND response inside
 * the same query; a retried request restarts a response the same way. Every response numbers its content
 * blocks from zero and reports its usage from zero, and a restart can arrive while the earlier block is still
 * open. The provider must present the responses as one assistant message with a sequential event protocol
 * (one open block, indices that only grow), or the text-tool-call recovery middleware ends the turn with
 * "Invalid assistant content event order" and the turn's reasoning is lost.
 */

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

const tools: Tool[] = [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }];

function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

function streamEvent(event: unknown): SDKMessage {
	return sdkMessage({ type: "stream_event", event, parent_tool_use_id: null, uuid: "evt", session_id: "s" });
}

function scriptedQuery(messages: readonly SDKMessage[]): SdkQuery {
	return () => {
		const query: SdkQueryHandle = {
			async *[Symbol.asyncIterator]() {
				for (const message of messages) yield message;
			},
			async interrupt() {},
			close() {},
		};
		return query;
	};
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function messageStart(id: string, cacheRead: number): SDKMessage {
	return streamEvent({
		type: "message_start",
		message: {
			id,
			usage: {
				input_tokens: 2,
				output_tokens: 0,
				cache_read_input_tokens: cacheRead,
				cache_creation_input_tokens: 100,
			},
		},
	});
}

function thinkingStart(index: number): SDKMessage {
	return streamEvent({
		type: "content_block_start",
		index,
		content_block: { type: "thinking", thinking: "", signature: "" },
	});
}

function thinkingDelta(index: number, text: string): SDKMessage {
	return streamEvent({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } });
}

function blockStop(index: number): SDKMessage {
	return streamEvent({ type: "content_block_stop", index });
}

function thinkingBlock(index: number, text: string): SDKMessage[] {
	return [
		thinkingStart(index),
		thinkingDelta(index, text),
		streamEvent({
			type: "content_block_delta",
			index,
			delta: { type: "signature_delta", signature: `sig-${index}` },
		}),
		blockStop(index),
	];
}

function messageEnd(stopReason: string, outputTokens: number): SDKMessage[] {
	return [
		streamEvent({
			type: "message_delta",
			delta: { stop_reason: stopReason },
			usage: { output_tokens: outputTokens },
		}),
		streamEvent({ type: "message_stop" }),
	];
}

const OUTPUT_LIMIT_NUDGE =
	"Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened.";

const nudge = sdkMessage({
	type: "user",
	message: { role: "user", content: OUTPUT_LIMIT_NUDGE },
	parent_tool_use_id: null,
	uuid: "nudge-1",
	session_id: "s",
	isMeta: true,
});

/** The continuation response: one thinking block, then the visible answer. */
const continuation: SDKMessage[] = [
	messageStart("msg-2", 515_000),
	...thinkingBlock(0, "resumed reasoning"),
	streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
	streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } }),
	blockStop(1),
	...messageEnd("end_turn", 50),
];

const result = sdkMessage({
	type: "result",
	subtype: "success",
	result: "Done.",
	stop_reason: "end_turn",
	usage: {
		input_tokens: 4,
		output_tokens: 64_050,
		cache_read_input_tokens: 1_003_121,
		cache_creation_input_tokens: 200,
	},
});

type Scenario = { name: string; messages: SDKMessage[]; thinking: string[]; restarts: number[] };

const scenarios: Scenario[] = [
	{
		name: "a continuation after a response the cap stopped between blocks",
		messages: [
			messageStart("msg-1", 488_121),
			...thinkingBlock(0, "long reasoning"),
			...thinkingBlock(1, "more reasoning"),
			...messageEnd("max_tokens", 64_000),
			nudge,
			...continuation,
			result,
		],
		thinking: ["long reasoning", "more reasoning", "resumed reasoning"],
		restarts: [0],
	},
	{
		name: "a continuation after a response the cap stopped inside a block (no content_block_stop)",
		messages: [
			messageStart("msg-1", 488_121),
			...thinkingBlock(0, "long reasoning"),
			thinkingStart(1),
			thinkingDelta(1, "cut mid-"),
			...messageEnd("max_tokens", 64_000),
			nudge,
			...continuation,
			result,
		],
		thinking: ["long reasoning", "cut mid-", "resumed reasoning"],
		restarts: [1],
	},
	{
		name: "a restarted response while its first block is still open",
		messages: [
			messageStart("msg-1", 488_121),
			...thinkingBlock(0, "long reasoning"),
			...messageEnd("max_tokens", 64_000),
			nudge,
			messageStart("msg-2a", 515_000),
			thinkingStart(0),
			thinkingDelta(0, "lost attempt"),
			...continuation,
			result,
		],
		thinking: ["long reasoning", "lost attempt", "resumed reasoning"],
		restarts: [0, 1],
	},
	{
		name: "a block re-emitted at the same index without the open block's stop",
		messages: [
			messageStart("msg-1", 488_121),
			thinkingStart(0),
			thinkingDelta(0, "first"),
			thinkingStart(0),
			thinkingDelta(0, "second"),
			blockStop(0),
			streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
			streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } }),
			blockStop(1),
			...messageEnd("end_turn", 50),
			result,
		],
		thinking: ["first", "second"],
		restarts: [],
	},
];

afterEach(() => {
	resetSdkBoundary();
});

describe("Claude SDK OAuth output-limit continuation", () => {
	for (const scenario of scenarios) {
		it(`streams ${scenario.name} as one sequential assistant message`, async () => {
			overrideSdkBoundary({ query: scriptedQuery(scenario.messages) });
			const inner = streamAnthropicSubscription(model, { messages: [] });
			const stream = wrapStreamWithModelRecovery(inner, model, tools);
			const events = await collect(stream);
			const errors = events.filter((event) => event.type === "error");
			expect(errors.map((event) => (event as { error: AssistantMessage }).error.errorMessage)).toEqual([]);
			const message = await stream.result();
			expect(message.stopReason).toBe("stop");
			expect(message.content.filter((block) => block.type === "thinking").map((block) => block.thinking)).toEqual(
				scenario.thinking,
			);
			expect(message.content.filter((block) => block.type === "text").map((block) => block.text)).toEqual(["Done."]);
			const thinkingStarts = events
				.filter((event) => event.type === "thinking_start")
				.map((event) => event.contentIndex);
			expect(thinkingStarts).toEqual(scenario.thinking.map((_, index) => index));
			const ends = events.filter((event) => event.type === "thinking_end" || event.type === "text_end");
			expect(ends).toHaveLength(scenario.thinking.length + 1);
			// One diagnostic per later response: how many SDK-left-open blocks the provider had to end for it.
			const restarts = (message.diagnostics ?? []).filter(
				(diagnostic) => diagnostic.type === RESPONSE_RESTART_DIAGNOSTIC,
			);
			expect(restarts.map((diagnostic) => diagnostic.details?.closedBlocks)).toEqual(scenario.restarts);
			if (restarts.length > 0) expect(restarts[0]?.details?.previousStopReason).toBe("length");
		});
	}

	it("adds the usage of every response of the query", async () => {
		const scenario = scenarios[0]!;
		overrideSdkBoundary({ query: scriptedQuery(scenario.messages.filter((entry) => entry.type !== "result")) });
		const stream = streamAnthropicSubscription(model, { messages: [] });
		await collect(stream);
		const message = await stream.result();
		// message_start reports input and cache tokens per response; message_delta the response's output tokens.
		expect(message.usage).toMatchObject({ input: 4, output: 64_050, cacheRead: 1_003_121, cacheWrite: 200 });
		expect(message.usage.totalTokens).toBe(4 + 64_050 + 1_003_121 + 200);
	});
});
