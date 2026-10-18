import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_STREAM_QUEUE_CAPACITY } from "../../../src/core/extensions/builtin/anthropic-subscription/bounded-queue.ts";
import type { SdkQueryHandle } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
	sessionRegistry,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { createSessionTurnAttempt } from "../../../src/core/extensions/builtin/anthropic-subscription/session-turn-attempt.ts";

const TOOL_CALL_DELTAS = 400;
const SESSION_ID = "senpi-2822-backpressure";

class ScriptedQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	private done = false;
	readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		if (this.done) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	async interrupt(): Promise<void> {}

	close(): void {
		this.done = true;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}
}

function toolCallDelta(index: number): SDKMessage {
	return {
		type: "stream_event",
		event: {
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: `"part-${index}",` },
		},
		parent_tool_use_id: null,
		uuid: `delta-${index}`,
		session_id: SESSION_ID,
	} as unknown as SDKMessage;
}

/** Lets the pump run until it stops pulling: the scripted backlog no longer changes between event-loop turns. */
async function settle(query: ScriptedQuery): Promise<void> {
	let previous = -1;
	for (let round = 0; round < 1_000 && previous !== query.queued.length; round++) {
		previous = query.queued.length;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function fixture() {
	const query = new ScriptedQuery();
	overrideSessionRegistryBoundary({ queryFactory: () => query });
	const entry = sessionRegistry.getOrCreate({
		senpiSessionId: SESSION_ID,
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
	});
	return { query, entry };
}

async function submittedUuid(entry: { inputController: AsyncIterable<SDKUserMessage> }): Promise<string> {
	for await (const message of entry.inputController) return message.uuid ?? "";
	throw new Error("expected a submitted user message");
}

describe("senpi#2822 a long streamed tool call on the anthropic-subscription lane", () => {
	afterEach(() => {
		closeSession(SESSION_ID, "test_complete");
		resetSessionRegistryBoundary();
	});

	it("streams more events than the queue holds without failing, and the pump waits for the reader", async () => {
		// given an attempt whose SDK stream sends one tool call as 400 deltas before the consumer reads anything
		const { query, entry } = fixture();
		const attempt = createSessionTurnAttempt(entry, { role: "user", content: "write the file" }, ["h1"], undefined, {
			emit: () => undefined,
		});
		const first = attempt.messages.next();
		const uuid = await submittedUuid(entry);
		query.emit({
			type: "user",
			message: { role: "user", content: "write the file" },
			parent_tool_use_id: null,
			uuid,
			session_id: SESSION_ID,
			isReplay: true,
		} as SDKMessage);
		for (let index = 0; index < TOOL_CALL_DELTAS; index++) query.emit(toolCallDelta(index));
		query.emit({
			type: "result",
			subtype: "success",
			user_message_uuid: uuid,
			uuid: "result",
			session_id: SESSION_ID,
			is_error: false,
			result: "done",
		} as unknown as SDKMessage);
		await settle(query);

		// then the pump stopped pulling once the queue was full instead of failing the query
		expect(query.queued.length).toBeGreaterThan(TOOL_CALL_DELTAS - SESSION_STREAM_QUEUE_CAPACITY - 2);

		// when the consumer reads the whole turn
		const received: SDKMessage[] = [];
		const firstResult = await first;
		if (!firstResult.done) received.push(firstResult.value);
		for await (const message of attempt.messages) received.push(message);

		// then every delta arrived in order and the turn completed
		const deltas = received.filter((message) => message.type === "stream_event");
		expect(deltas).toHaveLength(TOOL_CALL_DELTAS);
		expect(deltas.map((message) => message.uuid)).toEqual(
			Array.from({ length: TOOL_CALL_DELTAS }, (_, index) => `delta-${index}`),
		);
	});

	it("lets the pump finish the turn when the consumer stops reading early", async () => {
		// given a full queue whose consumer reads one message and then stops
		const { query, entry } = fixture();
		const attempt = createSessionTurnAttempt(entry, { role: "user", content: "write the file" }, ["h1"], undefined, {
			emit: () => undefined,
		});
		const first = attempt.messages.next();
		const uuid = await submittedUuid(entry);
		query.emit({
			type: "user",
			message: { role: "user", content: "write the file" },
			parent_tool_use_id: null,
			uuid,
			session_id: SESSION_ID,
			isReplay: true,
		} as SDKMessage);
		for (let index = 0; index < TOOL_CALL_DELTAS; index++) query.emit(toolCallDelta(index));
		query.emit({
			type: "result",
			subtype: "success",
			user_message_uuid: uuid,
			uuid: "result",
			session_id: SESSION_ID,
			is_error: false,
			result: "done",
		} as unknown as SDKMessage);
		await first;
		await settle(query);
		expect(query.queued.length).toBeGreaterThan(0);

		// when the consumer abandons the stream
		await attempt.messages.return(undefined);
		await settle(query);

		// then the pump read the rest of the turn instead of waiting for room forever
		expect(query.queued).toEqual([]);
		expect(entry.activeTurn).toBeNull();
	});
});
