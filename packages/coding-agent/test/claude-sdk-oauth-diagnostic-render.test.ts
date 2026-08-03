import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SDKUserMessage,
	type SdkQuery,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import {
	closeSession,
	markTainted,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { streamClaudeSdkOauth } from "../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";
import { ContinuityNoticeTracker } from "../src/modes/interactive/components/continuity-notice.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

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

function residentQuery(prompt: AsyncIterable<SDKUserMessage>) {
	const queued: SDKMessage[] = [];
	const readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];
	const emit = (message: SDKMessage): void => {
		const reader = readers.shift();
		if (reader) reader({ value: message, done: false });
		else queued.push(message);
	};
	let submitted = 0;
	void (async () => {
		for await (const message of prompt) {
			submitted++;
			const uuid = message.uuid ?? `submitted-${submitted}`;
			emit(sdkMessage({ ...message, uuid, isReplay: true }));
			emit(
				sdkMessage({
					type: "assistant",
					message: { id: `message-${uuid}`, type: "message", role: "assistant", content: [] },
					parent_tool_use_id: null,
					uuid: `assistant-${uuid}`,
					session_id: message.session_id,
				}),
			);
			emit(sdkMessage({ type: "result", subtype: "success", result: "ok", user_message_uuid: uuid }));
		}
	})();
	return {
		[Symbol.asyncIterator]: () => ({
			next: (): Promise<IteratorResult<SDKMessage>> => {
				const value = queued.shift();
				if (value) return Promise.resolve({ value, done: false });
				return new Promise((resolve) => readers.push(resolve));
			},
		}),
		initializationResult: async () => ({}),
		interrupt: async () => {},
		close: () => {
			for (const reader of readers.splice(0)) reader({ value: undefined, done: true });
		},
	};
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

function residentBoundary(): void {
	const query: SdkQuery = ({ prompt }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		return residentQuery(prompt);
	};
	overrideSdkBoundary({ query });
	overrideSessionRegistryBoundary({ queryFactory: query });
}

function diagnosticMessage(diagnostics: AssistantMessage["diagnostics"]): AssistantMessage {
	return { ...assistant("answer", 1), diagnostics };
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetContinuityObservabilityBoundary();
});

describe("Claude SDK OAuth continuity diagnostics", () => {
	it("attaches a continuity diagnostic to the assistant message on a degraded turn", async () => {
		residentBoundary();
		overrideContinuityObservabilityBoundary({ log: () => {} });
		const sessionId = "diagnostic-degraded";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		markTainted(sessionId, "compaction");
		const result = await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), { role: "user", content: "two", timestamp: 3 }] },
			mainOptions(sessionId),
		).result();

		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				type: "claude_sdk_oauth_session_continuity",
				details: { kind: "flatten", reason: "tainted_compaction", deltaMessages: 2 },
			}),
		]);
		expect(result.diagnostics?.[0]?.error).toBeUndefined();
	});

	it("attaches a continuity diagnostic on a healthy delta turn", async () => {
		residentBoundary();
		overrideContinuityObservabilityBoundary({ log: () => {} });
		const sessionId = "diagnostic-healthy";
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		await streamClaudeSdkOauth(model, { messages: [user1] }, mainOptions(sessionId)).result();
		const result = await streamClaudeSdkOauth(
			model,
			{ messages: [user1, assistant("a1", 2), { role: "user", content: "two", timestamp: 3 }] },
			mainOptions(sessionId),
		).result();

		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				type: "claude_sdk_oauth_session_continuity",
				details: { kind: "delta", reason: "prefix_matched", deltaMessages: 1 },
			}),
		]);
	});
});

describe("Continuity notice rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a muted notice for a flatten diagnostic", () => {
		const tracker = new ContinuityNoticeTracker();
		const notice = tracker.noticeFor(
			diagnosticMessage([
				{
					type: "claude_sdk_oauth_session_continuity",
					timestamp: 1,
					details: { kind: "flatten", reason: "tainted_compaction" },
				},
			]),
		);

		expect(notice).toContain("Session continuity");
		expect(notice).toContain("tainted_compaction");
	});

	it("stays silent for a healthy delta diagnostic", () => {
		const tracker = new ContinuityNoticeTracker();

		expect(
			tracker.noticeFor(
				diagnosticMessage([
					{
						type: "claude_sdk_oauth_session_continuity",
						timestamp: 1,
						details: { kind: "delta", reason: "prefix_matched", deltaMessages: 1 },
					},
				]),
			),
		).toBeUndefined();
		expect(
			tracker.noticeFor(
				diagnosticMessage([
					{
						type: "claude_sdk_oauth_session_continuity",
						timestamp: 1,
						details: { kind: "bootstrap", reason: "registry_miss" },
					},
				]),
			),
		).toBeUndefined();
	});

	it("renders the disabled notice only once per session", () => {
		const tracker = new ContinuityNoticeTracker();
		const message = diagnosticMessage([
			{
				type: "claude_sdk_oauth_session_continuity",
				timestamp: 1,
				details: { kind: "disabled", reason: "resume_mode_off" },
			},
		]);

		expect(tracker.noticeFor(message)).toContain("Session continuity");
		expect(tracker.noticeFor(message)).toBeUndefined();
	});

	it("renders the previously transported resume-fallback diagnostic", () => {
		const tracker = new ContinuityNoticeTracker();
		const notice = tracker.noticeFor(
			diagnosticMessage([
				{
					type: "claude_sdk_oauth_resume_fallback",
					timestamp: 1,
					error: { message: "resume initialization failed" },
				},
			]),
		);

		expect(notice).toContain("Session continuity");
	});

	it("stays silent for messages without continuity diagnostics", () => {
		const tracker = new ContinuityNoticeTracker();

		expect(tracker.noticeFor(diagnosticMessage(undefined))).toBeUndefined();
		expect(
			tracker.noticeFor(
				diagnosticMessage([{ type: "claude_sdk_oauth_deprecation", timestamp: 1, error: { message: "old" } }]),
			),
		).toBeUndefined();
	});
});
