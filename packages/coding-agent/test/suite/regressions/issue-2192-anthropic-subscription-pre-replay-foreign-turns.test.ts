import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	AnthropicSubscriptionSessionRegistry,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { submitSessionTurn } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-pump.ts";

class ScriptedQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	closes = 0;
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	async interrupt(): Promise<void> {}

	close(): void {
		this.closes++;
	}
}

const userContent = { role: "user", content: "hello" } as const;

function textDelta(uuid: string, sessionId: string, parentToolUseId: string | null = null): SDKMessage {
	return {
		type: "stream_event",
		event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "foreign" } },
		parent_tool_use_id: parentToolUseId,
		uuid,
		session_id: sessionId,
	} as SDKMessage;
}

function replayOf(uuid: string, sessionId: string): SDKMessage {
	return {
		type: "user",
		message: userContent,
		parent_tool_use_id: null,
		uuid,
		session_id: sessionId,
		isReplay: true,
	} as SDKMessage;
}

function resultOf(fields: Record<string, unknown>, sessionId: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "done",
		uuid: `result-${crypto.randomUUID()}`,
		session_id: sessionId,
		...fields,
	} as unknown as SDKMessage;
}

function pendingTurn() {
	const query = new ScriptedQuery();
	overrideSessionRegistryBoundary({ queryFactory: () => query });
	const registry = new AnthropicSubscriptionSessionRegistry();
	const entry = registry.getOrCreate({
		senpiSessionId: "issue-2192",
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
	});
	const turn = submitSessionTurn(registry, entry, { message: userContent });
	return { query, entry, turn };
}

async function submittedUuid(entry: { inputController: AsyncIterable<SDKUserMessage> }): Promise<string> {
	const item = await entry.inputController[Symbol.asyncIterator]().next();
	if (item.done || !item.value.uuid) throw new Error("Expected a submitted user message");
	return item.value.uuid;
}

function streamForeignTurn(query: ScriptedQuery, sessionId: string, count: number, parentToolUseId?: string): void {
	for (let index = 0; index < count; index++) {
		query.emit(textDelta(`foreign-${index}`, sessionId, parentToolUseId ?? null));
	}
}

afterEach(() => {
	resetSessionRegistryBoundary();
});

describe("regression #2192: another turn's events never fail the pending Anthropic Subscription turn", () => {
	it("waits out an autonomous turn that streams past the default caps and ends before our replay", async () => {
		const { query, entry, turn } = pendingTurn();
		const uuid = await submittedUuid(entry);

		// given: Claude Code is still running a turn it started itself when ours is submitted
		streamForeignTurn(query, entry.sdkSessionId, 200);
		query.emit(
			resultOf({ user_message_uuid: "autonomous-turn", origin: { kind: "task-notification" } }, entry.sdkSessionId),
		);

		// when: our queued message is replayed and answered
		const own = textDelta("own", entry.sdkSessionId);
		const terminal = resultOf({ user_message_uuid: uuid }, entry.sdkSessionId);
		query.emit(replayOf(uuid, entry.sdkSessionId));
		query.emit(own);
		query.emit(terminal);

		// then: the turn owns exactly its own messages and the resident query stays open
		expect((await turn).messages).toEqual([own, terminal]);
		expect(query.closes).toBe(0);
		expect(entry.state).toBe("IDLE_SYNCED");
	});

	it("drops an overflowing foreign segment instead of closing the query", async () => {
		const { query, entry, turn } = pendingTurn();
		const uuid = await submittedUuid(entry);

		// given: more pre-replay events than the default caps allow, with no foreign boundary
		streamForeignTurn(query, entry.sdkSessionId, 200);

		// when: our replay arrives
		const terminal = resultOf({ user_message_uuid: uuid }, entry.sdkSessionId);
		query.emit(replayOf(uuid, entry.sdkSessionId));
		query.emit(terminal);

		// then: none of the foreign events are flushed into our turn
		expect((await turn).messages).toEqual([terminal]);
		expect(query.closes).toBe(0);
	});

	it("never flushes a background subagent's events into the pending turn", async () => {
		const { query, entry, turn } = pendingTurn();
		const uuid = await submittedUuid(entry);

		// given: a background subagent streams while our turn waits for its replay
		streamForeignTurn(query, entry.sdkSessionId, 3, "toolu_background_agent");

		// when: our replay and result arrive
		const terminal = resultOf({ user_message_uuid: uuid }, entry.sdkSessionId);
		query.emit(replayOf(uuid, entry.sdkSessionId));
		query.emit(terminal);

		// then: the subagent's events stay out of our turn
		expect((await turn).messages).toEqual([terminal]);
	});

	it("treats an autonomous result without a user_message_uuid as another turn's end", async () => {
		const { query, entry, turn } = pendingTurn();
		const uuid = await submittedUuid(entry);

		// given: an older CLI reports the autonomous turn's result without a user_message_uuid
		streamForeignTurn(query, entry.sdkSessionId, 2);
		query.emit(resultOf({ origin: { kind: "task-notification" } }, entry.sdkSessionId));

		// when: our replay and result arrive
		const terminal = resultOf({ user_message_uuid: uuid }, entry.sdkSessionId);
		query.emit(replayOf(uuid, entry.sdkSessionId));
		query.emit(terminal);

		// then: our turn completes with only its own result
		expect((await turn).messages).toEqual([terminal]);
		expect(query.closes).toBe(0);
	});
});
