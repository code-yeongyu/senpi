import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";

// oh-my-openagent#10547: the Claude Agent SDK also writes each turn to ~/.claude/projects.
// Usage readers can only tell that copy apart from a real Claude Code turn by the Anthropic
// message id, so the assistant message has to carry it as `responseId`.

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function scriptedQuery(messages: readonly unknown[]): SdkQuery {
	return () => {
		const query: SdkQueryHandle = {
			async *[Symbol.asyncIterator]() {
				for (const message of messages) yield message as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
		return query;
	};
}

const result = {
	type: "result",
	subtype: "success",
	is_error: false,
	result: "Hello",
	stop_reason: "end_turn",
	usage: { input_tokens: 10, output_tokens: 2 },
	session_id: "session-1",
	uuid: "result-1",
};

function textTurn(messageStart: Record<string, unknown>): unknown[] {
	return [
		{ type: "stream_event", event: { type: "message_start", message: messageStart } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
		{
			type: "stream_event",
			event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
		},
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} } },
		result,
	];
}

describe("anthropic-subscription responseId (oh-my-openagent#10547)", () => {
	afterEach(() => resetSdkBoundary());

	it("records the Anthropic message id from message_start as responseId", async () => {
		overrideSdkBoundary({
			query: scriptedQuery(textTurn({ id: "msg_01OmoTurn", usage: { input_tokens: 10, output_tokens: 0 } })),
		});
		const stream = streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() });
		for await (const _event of stream) {
		}
		expect((await stream.result()).responseId).toBe("msg_01OmoTurn");
	});

	it("records the assistant message id when no stream events arrive", async () => {
		overrideSdkBoundary({
			query: scriptedQuery([
				{
					type: "assistant",
					message: { id: "msg_01ResultOnly", role: "assistant", content: [{ type: "text", text: "Hello" }] },
					parent_tool_use_id: null,
					session_id: "session-1",
					uuid: "assistant-1",
				},
				result,
			]),
		});
		const stream = streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() });
		for await (const _event of stream) {
		}
		const message = await stream.result();
		expect(message.responseId).toBe("msg_01ResultOnly");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("keeps the first response id when a stream event and an assistant message both carry one", async () => {
		const [start, ...rest] = textTurn({ id: "msg_01First", usage: { input_tokens: 10, output_tokens: 0 } });
		overrideSdkBoundary({
			query: scriptedQuery([
				start,
				{
					type: "assistant",
					message: { id: "msg_01Later", role: "assistant", content: [] },
					parent_tool_use_id: null,
					session_id: "session-1",
					uuid: "assistant-1",
				},
				{ type: "stream_event", event: { type: "message_start", message: { id: "msg_01Third", usage: {} } } },
				...rest,
			]),
		});
		const stream = streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() });
		for await (const _event of stream) {
		}
		expect((await stream.result()).responseId).toBe("msg_01First");
	});

	it("leaves responseId unset when message_start carries no id", async () => {
		overrideSdkBoundary({ query: scriptedQuery(textTurn({ usage: { input_tokens: 10, output_tokens: 0 } })) });
		const stream = streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() });
		for await (const _event of stream) {
		}
		expect((await stream.result()).responseId).toBeUndefined();
	});
});
