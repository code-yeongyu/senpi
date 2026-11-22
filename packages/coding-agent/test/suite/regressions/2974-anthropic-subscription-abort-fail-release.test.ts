import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
	BoundedAsyncQueue,
	SESSION_STREAM_QUEUE_CAPACITY,
} from "../../../src/core/extensions/builtin/anthropic-subscription/bounded-queue.ts";
import type { SdkQueryHandle } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	closeSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
	sessionRegistry,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { createSessionTurnAttempt } from "../../../src/core/extensions/builtin/anthropic-subscription/session-turn-attempt.ts";

const TOOL_CALL_DELTAS = 400;
const SESSION_ID = "senpi-2974-abort-fail-release";

class ScriptedQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	private done = false;
	readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];
	/** Resolved by interrupt(): the SDK's abort receipt. */
	interruptReceipt: unknown = undefined;

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

	async interrupt(): Promise<unknown> {
		return this.interruptReceipt;
	}

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

describe("senpi#2974 anthropic-subscription backpressure releases", () => {
	afterEach(() => {
		closeSession(SESSION_ID, "test_complete");
		resetSessionRegistryBoundary();
	});

	it("releases a pump blocked on a full queue when the turn is aborted, and keeps the session", async () => {
		// given a turn whose consumer reads nothing after the first message, so the pump blocks on writable()
		const { query, entry } = fixture();
		query.interruptReceipt = { still_queued: [] };
		const abort = new AbortController();
		const attempt = createSessionTurnAttempt(
			entry,
			{ role: "user", content: "write the file" },
			["h1"],
			abort.signal,
			{
				emit: () => undefined,
			},
		);
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
		await settle(query);

		// then the pump stopped pulling once the queue was full instead of failing the query
		// The margin of 2 covers the replay message and the one message handed straight to the waiting reader.
		expect(query.queued.length).toBeGreaterThan(TOOL_CALL_DELTAS - SESSION_STREAM_QUEUE_CAPACITY - 2);

		// when the turn is aborted while the pump is blocked, and the SDK then delivers its terminal result
		// (the consumer deliberately does NOT read anything after the abort: only an abort release can
		// move the pump now, a consumer drain would mask the stall)
		abort.abort();
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

		// then the pump read the terminal result instead of stalling past the abort grace, the interrupt
		// receipt was applied (nothing still queued), and the session survived instead of closing as
		// abort_uncertain. Without the abort release this fails: the pump stays blocked, the backlog
		// never drains, and the grace timer closes the session before the result is read.
		expect(query.queued).toEqual([]);
		expect(entry.activeTurn).toBeNull();
		expect(getSession(SESSION_ID)).toBe(entry);
		expect(entry.state).toBe("IDLE_SYNCED");

		// when the consumer finally reads the turn, every delta still arrives in order
		const received: SDKMessage[] = [];
		const firstResult = await first;
		if (!firstResult.done) received.push(firstResult.value);
		for await (const message of attempt.messages) received.push(message);
		const deltas = received.filter((message) => message.type === "stream_event");
		expect(deltas).toHaveLength(TOOL_CALL_DELTAS);
		expect(deltas.map((message) => message.uuid)).toEqual(
			Array.from({ length: TOOL_CALL_DELTAS }, (_, index) => `delta-${index}`),
		);
	});

	it("releases a producer blocked on writable() when the queue fails or closes", async () => {
		// given a full queue whose producer waits for room (fail path)
		const failing = new BoundedAsyncQueue<SDKMessage>(2);
		const failure = new Error("senpi#2974 fail release");
		failing.push(toolCallDelta(0));
		failing.push(toolCallDelta(1));
		let failReleased = false;
		const failWaiting = failing.writable();
		void failWaiting.then(() => {
			failReleased = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(failReleased).toBe(false);

		// when the queue fails
		failing.fail(failure);

		// then the waiting producer is released and the queued values drain before the failure surfaces
		await expect(failWaiting).resolves.toBeUndefined();
		await expect(failing.next()).resolves.toEqual({ value: toolCallDelta(0), done: false });
		await expect(failing.next()).resolves.toEqual({ value: toolCallDelta(1), done: false });
		await expect(failing.next()).rejects.toBe(failure);

		// given a full queue whose producer waits for room (close path)
		const closing = new BoundedAsyncQueue<SDKMessage>(2);
		closing.push(toolCallDelta(0));
		closing.push(toolCallDelta(1));
		let closeReleased = false;
		const closeWaiting = closing.writable();
		void closeWaiting.then(() => {
			closeReleased = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(closeReleased).toBe(false);

		// when the queue closes
		closing.close();

		// then the waiting producer is released and the queue ends cleanly after its buffered values
		await expect(closeWaiting).resolves.toBeUndefined();
		await expect(closing.next()).resolves.toEqual({ value: toolCallDelta(0), done: false });
	});
});
