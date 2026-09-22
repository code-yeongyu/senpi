import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { AssistantCommitBoundary } from "../src/core/extensions/builtin/claude-sdk-oauth/session-commit-boundary.ts";
import { decideNativeContinuity } from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import {
	emitContinuityObservation,
	observeSessionSyncDecision,
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import { sentMessageHashes, sentMessages } from "../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

/**
 * senpi#1975: an `assistant_rewritten` decision must name the FIRST diverged
 * field path of the semantic projection — paths only, never values — and that
 * path must travel with the decision: the pending-fork record on the registry
 * entry, the continuity observation, and the session.log continuity event.
 *
 * The wiring cases follow the pattern of
 * `claude-sdk-oauth-session-registry-wiring.test.ts` (fake extension API +
 * `registerSessionRegistry` + emitted `message_update`/`message_end`).
 */

const MODEL_ID = "claude-test";
const SUMMARY_92 = `eval finished in 41.2s with 3 tool calls${"x".repeat(50)}Z9`;
const SUMMARY_80 = SUMMARY_92.slice(0, 80);

function assistantWith(content: AssistantMessage["content"], model = MODEL_ID): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolCallAssistant(summary: string): AssistantMessage {
	return assistantWith([{ type: "toolCall", id: "toolu_eval", name: "eval", arguments: { summary } }]);
}

describe("issue #1975: assistant_rewritten names the first diverged path", () => {
	it("names the clamped toolCall summary path and never carries the value", () => {
		expect(SUMMARY_92).toHaveLength(92);
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("clamp", toolCallAssistant(SUMMARY_92));

		const result = boundary.commit("clamp", toolCallAssistant(SUMMARY_80), MODEL_ID);

		expect(result).toEqual({ outcome: "rewritten", divergedPath: "content[0].arguments.summary" });
		expect(JSON.stringify(result)).not.toContain("Z9");
		expect(JSON.stringify(result)).not.toContain(SUMMARY_80.slice(0, 40));
	});

	it("names the path when a shim mutates the captured arguments in place (#1472 class)", () => {
		const boundary = new AssistantCommitBoundary();
		const streamed = toolCallAssistant(SUMMARY_80);
		boundary.captureProviderFinal("in-place", streamed);

		// A shim mutating the same object after capture is the original #1472
		// defect shape: a referenced projection would follow the mutation.
		if (streamed.content[0]?.type !== "toolCall") throw new Error("expected a toolCall block");
		streamed.content[0].arguments.summary = SUMMARY_92;

		expect(boundary.commit("in-place", streamed, MODEL_ID)).toEqual({
			outcome: "rewritten",
			divergedPath: "content[0].arguments.summary",
		});
	});

	it("keeps a clean commit path-free", () => {
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("clean", toolCallAssistant(SUMMARY_80));

		expect(boundary.commit("clean", toolCallAssistant(SUMMARY_80), MODEL_ID)).toEqual({ outcome: "clean" });
	});

	it("keeps a non-resident commit path-free", () => {
		const boundary = new AssistantCommitBoundary();
		boundary.captureProviderFinal("foreign", toolCallAssistant(SUMMARY_80));

		expect(boundary.commit("foreign", toolCallAssistant(SUMMARY_80), "claude-other")).toEqual({
			outcome: "not-resident",
		});
	});

	it.each([
		[
			"content.length",
			[
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
			[{ type: "text", text: "a" }],
		],
		["content[0].type", [{ type: "text", text: "a" }], [{ type: "thinking", thinking: "a" }]],
		["content[0].text", [{ type: "text", text: "a" }], [{ type: "text", text: "b" }]],
		[
			"content[0].thinking",
			[{ type: "thinking", thinking: "a", thinkingSignature: "s" }],
			[{ type: "thinking", thinking: "b", thinkingSignature: "s" }],
		],
		[
			"content[0].thinkingSignature",
			[{ type: "thinking", thinking: "a", thinkingSignature: "s1" }],
			[{ type: "thinking", thinking: "a", thinkingSignature: "s2" }],
		],
		[
			"content[1].id",
			[
				{ type: "text", text: "a" },
				{ type: "toolCall", id: "t1", name: "eval", arguments: { summary: "s" } },
			],
			[
				{ type: "text", text: "a" },
				{ type: "toolCall", id: "t2", name: "eval", arguments: { summary: "s" } },
			],
		],
		[
			"content[0].name",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { summary: "s" } }],
			[{ type: "toolCall", id: "t1", name: "read", arguments: { summary: "s" } }],
		],
		[
			"content[0].arguments.data.label",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { data: { label: "a" } } }],
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { data: { label: "b" } } }],
		],
		[
			"content[0].arguments.items[1]",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { items: ["a", "b"] } }],
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { items: ["a", "c"] } }],
		],
		[
			"content[0].arguments.items[1]",
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { items: ["a"] } }],
			[{ type: "toolCall", id: "t1", name: "eval", arguments: { items: ["a", "c"] } }],
		],
		["model", [{ type: "text", text: "a" }], [{ type: "text", text: "a" }]],
	] as const)("names %s first", (_path, providerContent, committedContent) => {
		const boundary = new AssistantCommitBoundary();
		// The residency check gates the walk, so a model drift must sit on the
		// provider-final side for the committed message to stay resident.
		const providerModel = _path === "model" ? "claude-other" : MODEL_ID;
		boundary.captureProviderFinal("walk", assistantWith([...providerContent], providerModel));

		const result = boundary.commit("walk", assistantWith([...committedContent]), MODEL_ID);

		expect(result).toEqual({ outcome: "rewritten", divergedPath: _path });
	});
});

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakeExtension() {
	const handlers = new Map<string, EventHandler[]>();
	const api = {
		on(event: string, handler: EventHandler): void {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		getFlag(): undefined {
			return undefined;
		},
		registerFlag(): void {},
		registerCommand(): void {},
		registerProvider(): void {},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

function context(sessionId: string): ExtensionContext {
	return { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
	};
}

const sessionIds = new Set<string>();

function createEntry(sessionId: string) {
	sessionIds.add(sessionId);
	overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
	return getOrCreateSession({
		senpiSessionId: sessionId,
		accountName: "default",
		modelId: MODEL_ID,
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
	});
}

async function emitOnce(
	extension: { handlers: Map<string, EventHandler[]> },
	eventName: string,
	event: unknown,
	sessionId: string,
): Promise<void> {
	const handlers = extension.handlers.get(eventName) ?? [];
	expect(handlers).toHaveLength(1);
	for (const handler of handlers) await handler(event, context(sessionId));
}

function currentHashes(): string[] {
	const conversation: Context = { messages: [{ role: "user", content: "one", timestamp: 1 }] };
	return sentMessageHashes(sentMessages(conversation));
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
	resetContinuityObservabilityBoundary();
});

describe("issue #1975: the diverged path travels with the rewritten decision", () => {
	it("records the path on the pending fork and the next observation without the value", async () => {
		const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
		overrideContinuityObservabilityBoundary({ log: (event, data) => logged.push({ event, data }) });
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const entry = createEntry("diverged-path-wiring");

		await emitOnce(
			extension,
			"message_update",
			{ type: "message_update", message: toolCallAssistant(SUMMARY_92) },
			entry.senpiSessionId,
		);
		await emitOnce(
			extension,
			"message_end",
			{ type: "message_end", message: toolCallAssistant(SUMMARY_80) },
			entry.senpiSessionId,
		);

		const after = getSession("diverged-path-wiring");
		expect(after).toMatchObject({
			pendingForkReason: "assistant_rewritten",
			pendingForkDivergedPath: "content[0].arguments.summary",
		});

		const decision = decideNativeContinuity({
			entry: {
				sdkSessionId: entry.sdkSessionId,
				accountName: entry.accountName,
				modelId: entry.modelId,
				systemPromptHash: entry.systemPromptHash,
				toolsetHash: entry.toolsetHash,
				sentCount: 2,
				sentHashes: currentHashes(),
				lastAssistantUuid: "uuid-boundary-2",
				assistantUuidByIndex: new Map([
					[1, "uuid-boundary"],
					[2, "uuid-boundary-2"],
				]),
				pendingForkReason: after?.pendingForkReason ?? null,
			},
			binding: undefined,
			currentHashes: currentHashes(),
			accountName: entry.accountName,
			modelId: entry.modelId,
			fingerprint: { systemPromptHash: entry.systemPromptHash, toolsetHash: entry.toolsetHash },
			transcriptAvailable: true,
			crossAccountResumeSupported: true,
		});
		expect(decision).toMatchObject({ kind: "fork", reason: "assistant_rewritten" });

		const observation = observeSessionSyncDecision({
			kind: "resume",
			reason: "assistant_rewritten",
			deltaMessages: 2,
			firstTurn: false,
			senpiSessionId: entry.senpiSessionId,
			divergedPath: after?.pendingForkDivergedPath ?? undefined,
		});
		expect(observation.divergedPath).toBe("content[0].arguments.summary");

		emitContinuityObservation(observation);
		const line = logged.at(-1);
		expect(line?.event).toBe("claude_sdk_oauth_session_continuity");
		expect(line?.data.divergedPath).toBe("content[0].arguments.summary");
		expect(JSON.stringify(logged)).not.toContain("Z9");
		expect(JSON.stringify(logged)).not.toContain(SUMMARY_80.slice(0, 40));
	});

	it("leaves the pending fork path-free after a clean commit", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const entry = createEntry("diverged-path-clean");

		await emitOnce(
			extension,
			"message_update",
			{ type: "message_update", message: toolCallAssistant(SUMMARY_80) },
			entry.senpiSessionId,
		);
		await emitOnce(
			extension,
			"message_end",
			{ type: "message_end", message: toolCallAssistant(SUMMARY_80) },
			entry.senpiSessionId,
		);

		expect(getSession("diverged-path-clean")).toMatchObject({
			pendingForkReason: null,
			pendingForkDivergedPath: null,
		});
	});
});
