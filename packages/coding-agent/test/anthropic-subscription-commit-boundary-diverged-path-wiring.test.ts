import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	emitContinuityObservation,
	observeSessionSyncDecision,
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import { forgetBinding } from "../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	recordPendingFork,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

/** senpi#1975: the diverged path travels with an assistant_rewritten decision onto the ledger record, the pending fork, the observation and the session.log line. */

const MODEL_ID = "claude-test";
const SUMMARY_92 = `eval finished in 41.2s with 3 tool calls${"x".repeat(50)}Z9`;
const SUMMARY_80 = SUMMARY_92.slice(0, 80);

function toolCallAssistant(summary: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "toolu_eval", name: "eval", arguments: { summary } }],
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: MODEL_ID,
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

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakeExtension() {
	const handlers = new Map<string, EventHandler[]>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const api = {
		on(event: string, handler: EventHandler): void {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		appendEntry(customType: string, data: unknown): void {
			appended.push({ customType, data });
		},
		getFlag(): undefined {
			return undefined;
		},
		registerFlag(): void {},
		registerCommand(): void {},
		registerProvider(): void {},
	} as unknown as ExtensionAPI;
	return { api, handlers, appended };
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

async function streamThenCommit(
	extension: { handlers: Map<string, EventHandler[]> },
	sessionId: string,
	streamed: AssistantMessage,
	committed: AssistantMessage,
): Promise<void> {
	await emitOnce(extension, "message_update", { type: "message_update", message: streamed }, sessionId);
	await emitOnce(extension, "message_end", { type: "message_end", message: committed }, sessionId);
}

afterEach(() => {
	for (const sessionId of sessionIds) {
		closeSession(sessionId, "test_cleanup");
		forgetBinding(sessionId);
	}
	sessionIds.clear();
	resetSessionRegistryBoundary();
	resetContinuityObservabilityBoundary();
});

describe("issue #1975: the diverged path travels with the rewritten decision", () => {
	it("records the path on the ledger record, the pending fork and the next observation without the value", async () => {
		const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
		overrideContinuityObservabilityBoundary({ log: (event, data) => logged.push({ event, data }) });
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const entry = createEntry("diverged-path-wiring");

		await streamThenCommit(
			extension,
			entry.senpiSessionId,
			toolCallAssistant(SUMMARY_92),
			toolCallAssistant(SUMMARY_80),
		);

		expect(getSession(entry.senpiSessionId)).toMatchObject({
			pendingForkReason: "assistant_rewritten",
			pendingForkDivergedPath: "content[0].arguments.summary",
		});
		expect(extension.appended.map((record) => record.data)).toEqual([
			{
				schemaVersion: 1,
				invalidated: true,
				reason: "assistant_rewritten",
				divergedPath: "content[0].arguments.summary",
			},
		]);

		for (const kind of ["resume", "cold-seed"] as const) {
			const observation = observeSessionSyncDecision({
				kind,
				reason: "assistant_rewritten",
				deltaMessages: 2,
				firstTurn: false,
				senpiSessionId: entry.senpiSessionId,
				divergedPath: "content[0].arguments.summary",
			});
			expect(observation.divergedPath, kind).toBe("content[0].arguments.summary");
			emitContinuityObservation(observation, entry.senpiSessionId);
			const line = logged.at(-1);
			expect(line?.event).toBe("claude_sdk_oauth_session_continuity");
			expect(line?.data.divergedPath).toBe("content[0].arguments.summary");
		}
		expect(JSON.stringify([logged, extension.appended])).not.toContain("Z9");
		expect(JSON.stringify([logged, extension.appended])).not.toContain(SUMMARY_80.slice(0, 40));
	});

	it("leaves the pending fork and ledger path-free after a clean commit", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const entry = createEntry("diverged-path-clean");

		await streamThenCommit(
			extension,
			entry.senpiSessionId,
			toolCallAssistant(SUMMARY_80),
			toolCallAssistant(SUMMARY_80),
		);

		expect(getSession(entry.senpiSessionId)).toMatchObject({
			pendingForkReason: null,
			pendingForkDivergedPath: null,
		});
		expect(JSON.stringify(extension.appended)).not.toContain("divergedPath");
	});

	it("does not carry a rewrite's path onto a later pending fork recorded without one", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const entry = createEntry("diverged-path-stale");

		await streamThenCommit(
			extension,
			entry.senpiSessionId,
			toolCallAssistant(SUMMARY_92),
			toolCallAssistant(SUMMARY_80),
		);
		recordPendingFork(entry.senpiSessionId, "compaction");

		expect(getSession(entry.senpiSessionId)).toMatchObject({
			pendingForkReason: "compaction",
			pendingForkDivergedPath: null,
		});
	});

	it("omits divergedPath from an observation that was not given one", () => {
		const observation = observeSessionSyncDecision({
			kind: "resume",
			reason: "compaction",
			deltaMessages: 1,
			firstTurn: false,
			senpiSessionId: "diverged-path-none",
		});
		expect("divergedPath" in observation).toBe(false);
	});
});
