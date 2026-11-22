import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	AnthropicSubscriptionSessionRegistry,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import {
	ConcurrentSessionTurnAdmissionError,
	SESSION_TURN_ADMISSION_WAIT_MS,
	submitSessionTurn,
} from "../src/core/extensions/builtin/anthropic-subscription/session-registry-pump.ts";

// A follow-up turn (a steer, a monitor notification, a stop-hook message) is submitted by the agent loop right
// after it finished consuming the previous turn, while the pump still waits for the SDK's terminal result of that
// turn. Before this guard the second submission threw ConcurrentSessionTurnAdmissionError synchronously, the
// stream classified it as a provider failure and the session was moved to a fallback model (observed on
// omo-ai 5.1.35 / senpi 2026.10.16: six Opus children moved to GPT in one morning).

class ScriptedQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	private done = false;
	private readonly queued: SDKMessage[] = [];
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

const userContent = { role: "user", content: "hello" } as const;

function replay(uuid: string, sessionId: string): SDKMessage {
	return {
		type: "user",
		message: userContent,
		parent_tool_use_id: null,
		uuid,
		session_id: sessionId,
		isReplay: true,
	} as SDKMessage;
}

function result(uuid: string, sessionId: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		user_message_uuid: uuid,
		uuid: `result-${uuid}`,
		session_id: sessionId,
		is_error: false,
		result: "done",
	} as unknown as SDKMessage;
}

function fixture() {
	const query = new ScriptedQuery();
	overrideSessionRegistryBoundary({ queryFactory: () => query });
	const registry = new AnthropicSubscriptionSessionRegistry();
	const entry = registry.getOrCreate({
		senpiSessionId: "turn-admission-wait",
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
	});
	return { query, registry, entry };
}

async function submittedMessage(entry: { inputController: AsyncIterable<SDKUserMessage> }): Promise<SDKUserMessage> {
	for await (const message of entry.inputController) return message;
	throw new Error("input closed");
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	resetSessionRegistryBoundary();
});

describe("anthropic-subscription turn admission", () => {
	it("waits for the active turn to settle, then submits the next turn", async () => {
		const { query, registry, entry } = fixture();
		const first = submitSessionTurn(registry, entry, { message: userContent });
		const firstInput = await submittedMessage(entry);
		let secondState: "pending" | "resolved" | "rejected" = "pending";
		const second = submitSessionTurn(registry, entry, { message: userContent });
		second.then(
			() => {
				secondState = "resolved";
			},
			() => {
				secondState = "rejected";
			},
		);
		await settle();
		expect(secondState).toBe("pending");

		query.emit(replay(firstInput.uuid as string, entry.sdkSessionId));
		query.emit(result(firstInput.uuid as string, entry.sdkSessionId));
		const firstTurn = await first;
		expect(firstTurn.aborted).toBe(false);

		const secondInput = await submittedMessage(entry);
		expect(secondInput.uuid).not.toBe(firstInput.uuid);
		query.emit(replay(secondInput.uuid as string, entry.sdkSessionId));
		query.emit(result(secondInput.uuid as string, entry.sdkSessionId));
		const secondTurn = await second;
		expect(secondTurn.aborted).toBe(false);
		expect(secondTurn.uuid).toBe(secondInput.uuid);
		expect(secondState).toBe("resolved");
		query.close();
	});

	it("keeps the refusal when the active turn does not settle within the bound", async () => {
		const { registry, entry } = fixture();
		const first = submitSessionTurn(registry, entry, { message: userContent });
		await submittedMessage(entry);
		const timers: Array<{ callback: () => void; delayMs: number }> = [];
		const second = submitSessionTurn(registry, entry, {
			message: userContent,
			scheduleAbort: (callback, delayMs) => {
				timers.push({ callback, delayMs });
				return () => {};
			},
		});
		const rejection = second.catch((error: unknown) => error);
		expect(timers).toHaveLength(1);
		expect(timers[0]?.delayMs).toBe(SESSION_TURN_ADMISSION_WAIT_MS);
		timers[0]?.callback();
		expect(await rejection).toBeInstanceOf(ConcurrentSessionTurnAdmissionError);
		// The active turn is untouched by the refusal.
		let firstState = "pending";
		first.then(
			() => {
				firstState = "resolved";
			},
			() => {
				firstState = "rejected";
			},
		);
		await settle();
		expect(firstState).toBe("pending");
	});

	it("resolves a waiting turn as aborted when its signal aborts, leaving the active turn alone", async () => {
		const { query, registry, entry } = fixture();
		const first = submitSessionTurn(registry, entry, { message: userContent });
		const firstInput = await submittedMessage(entry);
		const controller = new AbortController();
		const second = submitSessionTurn(registry, entry, { message: userContent, signal: controller.signal });
		controller.abort();
		const secondTurn = await second;
		expect(secondTurn.aborted).toBe(true);
		expect(secondTurn.messages).toEqual([]);
		query.emit(replay(firstInput.uuid as string, entry.sdkSessionId));
		query.emit(result(firstInput.uuid as string, entry.sdkSessionId));
		expect((await first).aborted).toBe(false);
		query.close();
	});
});
