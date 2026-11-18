import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	AnthropicSubscriptionSessionRegistry,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { submitSessionTurn } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-pump.ts";

// senpi#4137: events that arrive before our prompt's replay echo are held in a bounded buffer and dropped
// on overflow as another turn's (senpi#2192). When our OWN result then arrives without that echo, the
// dropped segment was this turn's output, yet the turn resolved as a successful answer with no content.
// The attempt was recorded as synced, so the empty-response retry sent a zero-message delta onto a
// transcript that already held the lost tool call, and the model answered "waiting for the tool result".

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

const userContent = { role: "user", content: "run the tool" } as const;

function toolUseDelta(index: number, sessionId: string): SDKMessage {
	return {
		type: "stream_event",
		event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "x" } },
		parent_tool_use_id: null,
		uuid: `own-${index}`,
		session_id: sessionId,
	} as SDKMessage;
}

function ownResult(uuid: string, sessionId: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "",
		stop_reason: "tool_use",
		user_message_uuid: uuid,
		uuid: `result-${uuid}`,
		session_id: sessionId,
	} as unknown as SDKMessage;
}

function pendingTurn() {
	const query = new ScriptedQuery();
	overrideSessionRegistryBoundary({ queryFactory: () => query });
	const registry = new AnthropicSubscriptionSessionRegistry();
	const entry = registry.getOrCreate({
		senpiSessionId: "issue-4137",
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

afterEach(() => {
	resetSessionRegistryBoundary();
});

describe("regression #4137: a turn whose own output was dropped before its replay claim is never an answer", () => {
	it("Given our turn streams past the pre-replay caps with no replay echo when our own result arrives then the turn fails instead of resolving empty", async () => {
		// Given
		const { query, entry, turn } = pendingTurn();
		const uuid = await submittedUuid(entry);
		for (let index = 0; index < 200; index++) query.emit(toolUseDelta(index, entry.sdkSessionId));

		// When
		query.emit(ownResult(uuid, entry.sdkSessionId));

		// Then
		await expect(turn).rejects.toMatchObject({ code: "claude_sdk_oauth_turn_attribution" });
	});

	it("Given our own result arrives before any replay echo with nothing dropped when it ends the turn then the turn still resolves", async () => {
		// Given
		const { query, entry, turn } = pendingTurn();
		const uuid = await submittedUuid(entry);
		const delta = toolUseDelta(0, entry.sdkSessionId);
		query.emit(delta);

		// When
		const terminal = ownResult(uuid, entry.sdkSessionId);
		query.emit(terminal);

		// Then
		expect((await turn).messages).toEqual([delta, terminal]);
	});
});
