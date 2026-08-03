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
import {
	type ContinuityObservation,
	consumePendingCloseCause,
	overrideContinuityObservabilityBoundary,
	recordPendingCloseCause,
	resetContinuityObservabilityBoundary,
	sanitizeCloseCause,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import {
	closeSession,
	markTainted,
	overrideSessionRegistryBoundary,
	recordBranchInfo,
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
	readonly options: Options;
	closes = 0;
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options) {
		this.options = options;
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

	protected emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	private async consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
		for await (const message of prompt) {
			this.submitted.push(message);
			const uuid = message.uuid ?? `submitted-${this.submitted.length}`;
			const sessionId = message.session_id;
			this.emit(sdkMessage({ ...message, uuid, session_id: sessionId, isReplay: true }));
			this.emit(
				sdkMessage({
					type: "assistant",
					message: { id: `message-${uuid}`, type: "message", role: "assistant", content: [] },
					parent_tool_use_id: null,
					uuid: `assistant-${uuid}`,
					session_id: sessionId,
				}),
			);
			this.emit(
				sdkMessage({
					type: "result",
					subtype: "success",
					result: `answer-${this.submitted.length}`,
					user_message_uuid: uuid,
					uuid: `result-${uuid}`,
					session_id: sessionId,
				}),
			);
		}
	}
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

function residentBoundary(
	createResident?: (prompt: AsyncIterable<SDKUserMessage>, options: Options, index: number) => SdkQueryHandle,
) {
	const queries: SdkQueryHandle[] = [];
	const query: SdkQuery = (input) => {
		const { prompt, options = {} } = input;
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const resident = createResident?.(prompt, options, queries.length) ?? new ResidentQuery(prompt, options);
		queries.push(resident);
		return resident;
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
	return queries;
}

function observationSink() {
	const observations: ContinuityObservation[] = [];
	const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
	overrideContinuityObservabilityBoundary({
		emit: (observation) => observations.push(observation),
		log: (event, data) => logged.push({ event, data }),
	});
	return { observations, logged };
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetContinuityObservabilityBoundary();
});

describe("Claude SDK OAuth continuity observations", () => {
	it("emits bootstrap then delta with the delta message count for a healthy conversation", async () => {
		residentBoundary();
		const sink = observationSink();
		const sessionId = "observability-healthy";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		const user2 = { role: "user" as const, content: "two", timestamp: 3 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2] },
			mainOptions(sessionId),
		).result();

		expect(sink.observations).toEqual([
			{ kind: "bootstrap", reason: "registry_miss", deltaMessages: 1 },
			{ kind: "delta", reason: "prefix_matched", deltaMessages: 1 },
		]);
	});

	it("emits a flatten observation with a sanitized reason when the session is tainted", async () => {
		residentBoundary();
		const sink = observationSink();
		const sessionId = "observability-tainted";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		markTainted(sessionId, "compaction");
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), { role: "user", content: "two", timestamp: 3 }] },
			mainOptions(sessionId),
		).result();

		expect(sink.observations.at(-1)).toMatchObject({ kind: "flatten", reason: "tainted_compaction" });
	});

	it("attributes the retained close cause to the next turn after a model switch closes the session", async () => {
		residentBoundary();
		const sink = observationSink();
		const sessionId = "observability-close-cause";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		closeSession(sessionId, "model_selected");
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), { role: "user", content: "two", timestamp: 3 }] },
			mainOptions(sessionId),
		).result();

		expect(sink.observations.at(-1)).toMatchObject({ kind: "fork", reason: "model_selected" });
	});

	it("emits exactly one observation per turn on the resume-fallback path", async () => {
		residentBoundary((prompt, options, index) => {
			if (index !== 1) return new ResidentQuery(prompt, options);
			const failing = new ResidentQuery(prompt, options);
			failing.initializationResult = () => Promise.reject(new Error("resume initialization failed"));
			return failing;
		});
		const sink = observationSink();
		const sessionId = "observability-resume-fallback";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		const user2 = { role: "user" as const, content: "two", timestamp: 3 };
		const user3 = { role: "user" as const, content: "three", timestamp: 5 };
		const contexts: Context[] = [
			{ messages: [user1] },
			{ messages: [user1, assistant("a1", 2), user2] },
			{ messages: [user1, assistant("a1", 2), user2, assistant("a2", 4), user3] },
		];
		for (const contextValue of contexts) {
			await streamClaudeSdkOauth(model, contextValue, mainOptions(sessionId)).result();
		}
		recordBranchInfo(sessionId, { oldLeafId: "old", newLeafId: "new" });
		const before = sink.observations.length;
		await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), user2] },
			mainOptions(sessionId),
		).result();

		expect(sink.observations.length - before).toBe(1);
		expect(sink.observations.at(-1)).toMatchObject({ kind: "flatten", reason: "resume_initialization_failed" });
	});

	it("emits a disabled observation for the non-resident path when resume mode is off", async () => {
		const sink = observationSink();
		process.env.SENPI_CLAUDE_SDK_OAUTH_RESUME = "off";
		try {
			overrideSdkBoundary({
				query: () => ({
					async *[Symbol.asyncIterator]() {
						yield sdkMessage({ type: "result", subtype: "success", result: "flat" });
					},
					async interrupt() {},
					close() {},
				}),
			});
			await streamClaudeSdkOauth(
				model,
				{ messages: [{ role: "user", content: "one", timestamp: 1 }] },
				mainOptions("observability-disabled"),
			).result();
		} finally {
			delete process.env.SENPI_CLAUDE_SDK_OAUTH_RESUME;
		}

		expect(sink.observations).toEqual([{ kind: "disabled", reason: "resume_mode_off" }]);
	});

	it("emits one terminal error observation when every attempt fails", async () => {
		const sink = observationSink();
		const failing: SdkQuery = () => ({
			[Symbol.asyncIterator]: (): AsyncIterator<SDKMessage> => ({
				next: () => Promise.reject(new Error("token bucket drained: sk-ant-secret")),
			}),
			interrupt: async () => {},
			close: () => {},
		});
		overrideSdkBoundary({ query: failing });
		overrideSessionRegistryBoundary({ queryFactory: failing });
		await streamClaudeSdkOauth(
			model,
			{ messages: [{ role: "user", content: "one", timestamp: 1 }] },
			mainOptions("observability-terminal-error"),
		).result();

		const terminal = sink.observations.filter((observation) => observation.kind === "flatten");
		expect(sink.observations.at(-1)).toEqual({ kind: "flatten", reason: "query_failed" });
		expect(terminal).toHaveLength(1);
		expect(JSON.stringify(sink.observations)).not.toContain("sk-ant-secret");
	});

	it("logs structured continuity events through the session logger", async () => {
		residentBoundary();
		const sink = observationSink();
		const sessionId = "observability-log";
		await streamClaudeSdkOauth(
			model,
			{ messages: [{ role: "user", content: "one", timestamp: 1 }] },
			mainOptions(sessionId),
		).result();

		expect(sink.logged).toEqual([
			{
				event: "claude_sdk_oauth_session_continuity",
				data: { kind: "bootstrap", reason: "registry_miss", count: 1 },
			},
		]);
	});

	it("sanitizes arbitrary close and pump errors into the fixed cause vocabulary", () => {
		expect(sanitizeCloseCause(new Error("Claude SDK OAuth query ended before the active turn completed"))).toBe(
			"query_failed",
		);
		expect(sanitizeCloseCause("Claude SDK OAuth result user_message_uuid did not match the active turn")).toBe(
			"turn_attribution_failed",
		);
		expect(sanitizeCloseCause("Claude SDK OAuth interrupted turn did not terminate")).toBe("abort_timeout");
		expect(sanitizeCloseCause(new Error("weird failure with token sk-ant-oops"))).toBe("other");
	});

	it("consumes a pending close cause exactly once", () => {
		recordPendingCloseCause("one-shot", "capacity");
		expect(consumePendingCloseCause("one-shot")).toBe("capacity");
		expect(consumePendingCloseCause("one-shot")).toBeUndefined();
	});
});
