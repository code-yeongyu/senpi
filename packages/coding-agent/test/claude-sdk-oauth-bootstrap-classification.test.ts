import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SDKUserMessage,
	type SdkQuery,
	type SdkQueryHandle,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import type { ContinuityObservation } from "../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { streamClaudeSdkOauth } from "../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

class ResidentQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	constructor(prompt: AsyncIterable<SDKUserMessage>) {
		void this.consume(prompt);
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	async initializationResult(): Promise<Record<string, never>> {
		return {};
	}

	async interrupt(): Promise<void> {}

	close(): void {
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}

	private emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
		let index = 0;
		for await (const message of prompt) {
			index++;
			const uuid = message.uuid ?? `submitted-${index}`;
			this.emit(sdkMessage({ ...message, uuid, isReplay: true }));
			this.emit(
				sdkMessage({
					type: "assistant",
					message: { id: `message-${uuid}`, type: "message", role: "assistant", content: [] },
					parent_tool_use_id: null,
					uuid: `assistant-${uuid}`,
					session_id: message.session_id,
				}),
			);
			this.emit(
				sdkMessage({
					type: "result",
					subtype: "success",
					result: `answer-${index}`,
					user_message_uuid: uuid,
					uuid: `result-${uuid}`,
					session_id: message.session_id,
				}),
			);
		}
	}
}

function residentBoundary(): void {
	const query: SdkQuery = (input) => {
		if (typeof input.prompt === "string") throw new Error("Expected streaming input");
		return new ResidentQuery(input.prompt);
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

const sessionIds = new Set<string>();

function mainOptions(sessionId: string) {
	sessionIds.add(sessionId);
	return { sessionId, streamKind: "main" as const };
}

function observations(): ContinuityObservation[] {
	const result: ContinuityObservation[] = [];
	overrideContinuityObservabilityBoundary({ emit: (observation) => result.push(observation) });
	return result;
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetContinuityObservabilityBoundary();
});

describe("Claude SDK OAuth bootstrap classification", () => {
	it("bootstraps a fresh multi-message first turn with no prior assistant", async () => {
		residentBoundary();
		const observed = observations();
		const sessionId = "bootstrap-multi-message";
		const context: Context = {
			messages: [
				{ role: "user", content: "injected context", timestamp: 1 },
				{ role: "user", content: "actual prompt", timestamp: 2 },
			],
		};

		await streamClaudeSdkOauth(model, context, mainOptions(sessionId)).result();

		expect(observed).toContainEqual(expect.objectContaining({ kind: "bootstrap", reason: "registry_miss" }));
	});

	it("flattens a fresh context that already has an assistant message", async () => {
		residentBoundary();
		const observed = observations();
		const sessionId = "bootstrap-prior-assistant";
		const context: Context = {
			messages: [
				{ role: "user", content: "injected context", timestamp: 1 },
				assistant("prior answer", 2),
				{ role: "user", content: "actual prompt", timestamp: 3 },
			],
		};

		await streamClaudeSdkOauth(model, context, mainOptions(sessionId)).result();

		expect(observed).toContainEqual(expect.objectContaining({ kind: "flatten", reason: "registry_miss" }));
	});
});
