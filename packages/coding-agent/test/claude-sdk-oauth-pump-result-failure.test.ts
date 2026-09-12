import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SdkResultFailure } from "../src/core/extensions/builtin/claude-sdk-oauth/errors.ts";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	ClaudeSdkOauthSessionRegistry,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { submitSessionTurn } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-pump.ts";

// Real shapes captured from the bundled Claude Code 2.1.241 binary on
// claude-fable-5-1 (evidence g1-binary-probe-red.json) and from issue #1169.
const VERSION_FLOOR_TEXT =
	"API Error: 400 Claude Code 2.1.241 does not support this model; version 2.1.251 or newer is required.";

class ScriptedQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	closes = 0;
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
		this.closes++;
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

function result(uuid: string | undefined, sessionId: string, overrides: Record<string, unknown>): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		user_message_uuid: uuid,
		uuid: "result",
		session_id: sessionId,
		is_error: false,
		result: "done",
		...overrides,
	} as unknown as SDKMessage;
}

function fixture() {
	const query = new ScriptedQuery();
	overrideSessionRegistryBoundary({ queryFactory: () => query });
	const registry = new ClaudeSdkOauthSessionRegistry();
	const entry = registry.getOrCreate({
		senpiSessionId: "pump-result-failure",
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
	});
	return { query, registry, entry };
}

async function submittedMessage(entry: { inputController: AsyncIterable<SDKUserMessage> }): Promise<SDKUserMessage> {
	const item = await entry.inputController[Symbol.asyncIterator]().next();
	if (item.done) throw new Error("Expected a submitted user message");
	return item.value;
}

afterEach(() => {
	resetSessionRegistryBoundary();
});

describe("claude-sdk-oauth pump: is_error results (#1169 / #1298)", () => {
	it("fails the claimed turn with the API text and closes the session on an is_error success result", async () => {
		const { query, registry, entry } = fixture();
		const turn = submitSessionTurn(registry, entry, { message: userContent });
		const submitted = await submittedMessage(entry);
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		query.emit(
			result(submitted.uuid, entry.sdkSessionId, {
				is_error: true,
				api_error_status: 400,
				terminal_reason: "api_error",
				result: VERSION_FLOOR_TEXT,
				usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 5 },
			}),
		);

		await expect(turn).rejects.toThrow(/does not support this model.*\(HTTP 400, api_error\)/);
		// The rejection carries the billed usage so the outer stream can account for it.
		await expect(turn).rejects.toSatisfy(
			(error: unknown) => error instanceof SdkResultFailure && error.usage?.input_tokens === 7,
		);
		expect(registry.get("pump-result-failure")).toBeUndefined();
		expect(entry.activeTurn).toBeNull();
	});

	it("surfaces an is_error result that arrives before the replay claim as the API failure", async () => {
		const { query, registry, entry } = fixture();
		const turn = submitSessionTurn(registry, entry, { message: userContent });
		const submitted = await submittedMessage(entry);
		// No replay echo: the SDK failed the request before it ever confirmed our user message.
		query.emit(
			result(submitted.uuid, entry.sdkSessionId, {
				is_error: true,
				api_error_status: 429,
				terminal_reason: "blocking_limit",
				result: "You've hit your session limit · resets 2:50pm (Asia/Seoul)",
			}),
		);

		await expect(turn).rejects.toThrow(/session limit.*\(HTTP 429, blocking_limit\)/);
		await expect(turn).rejects.not.toThrow(/before replay claim/);
	});

	it("keeps an ordinary success result on the idle-synced path", async () => {
		const { query, registry, entry } = fixture();
		const turn = submitSessionTurn(registry, entry, { message: userContent });
		const submitted = await submittedMessage(entry);
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		query.emit(result(submitted.uuid, entry.sdkSessionId, {}));

		const settled = await turn;
		expect(settled.messages.map((message) => message.type)).toEqual(["result"]);
		expect(entry.state).toBe("IDLE_SYNCED");
		expect(registry.get("pump-result-failure")).toBe(entry);
	});
});
