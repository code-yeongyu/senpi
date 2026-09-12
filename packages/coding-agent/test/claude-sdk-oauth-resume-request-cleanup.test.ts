import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Options,
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
	getSession,
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
	readonly submitted: SDKUserMessage[] = [];
	closes = 0;
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
		this.closes++;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}

	private emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
		for await (const message of prompt) {
			this.submitted.push(message);
			const uuid = message.uuid ?? `submitted-${this.submitted.length}`;
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
					result: `answer-${this.submitted.length}`,
					user_message_uuid: uuid,
					uuid: `result-${uuid}`,
					session_id: message.session_id,
				}),
			);
		}
	}
}

function residentBoundary(): ResidentQuery[] {
	const queries: ResidentQuery[] = [];
	const query: SdkQuery = (input) => {
		const { prompt, options = {} } = input;
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		void (options as Options);
		const resident = new ResidentQuery(prompt);
		queries.push(resident);
		return resident;
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
	return queries;
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
	const captured: ContinuityObservation[] = [];
	overrideContinuityObservabilityBoundary({ emit: (observation) => captured.push(observation) });
	return captured;
}

function textFrom(message: SDKUserMessage): string {
	const content = message.message.content;
	if (typeof content === "string") return content;
	return content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("")
		.trim();
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetContinuityObservabilityBoundary();
});

describe("Claude SDK OAuth resumed query survives completed-request cleanup", () => {
	it("stays on one resumed query and answers the next turn incrementally", async () => {
		const queries = residentBoundary();
		const observed = observations();
		const sessionId = "resume-request-cleanup";
		const first = { role: "user" as const, content: "one", timestamp: 1 };
		const second = { role: "user" as const, content: "two", timestamp: 3 };
		const third = { role: "user" as const, content: "three", timestamp: 5 };

		// Given a session whose resident entry retired while its binding survived, so the
		// next turn takes the resume path and carries the request's abort signal
		await streamClaudeSdkOauth(model, { messages: [first] }, mainOptions(sessionId)).result();
		closeSession(sessionId, "idle_ttl");

		const completedRequest = new AbortController();
		const resumedTurn: Context = { messages: [first, assistant("answer-1", 2), second] };
		await streamClaudeSdkOauth(model, resumedTurn, {
			...mainOptions(sessionId),
			signal: completedRequest.signal,
		}).result();

		// When the agent loop aborts that request's controller during ordinary
		// completed-request cleanup
		completedRequest.abort();
		await Promise.resolve();

		// Then the resumed query stays resident and the next turn is a delta on it
		expect(getSession(sessionId)).toBeDefined();

		await streamClaudeSdkOauth(
			model,
			{ messages: [first, assistant("answer-1", 2), second, assistant("answer-2", 4), third] },
			mainOptions(sessionId),
		).result();

		expect(queries).toHaveLength(2);
		expect(queries[1]?.closes).toBe(0);
		expect(queries[1]?.submitted.map(textFrom)).toEqual(["two", "three"]);
		expect(observed.at(-1)).toMatchObject({ kind: "delta" });
	});
});
