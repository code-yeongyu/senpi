import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import claudeSdkOauthExtension from "../src/core/extensions/builtin/claude-sdk-oauth/index.ts";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { decideNativeContinuity } from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import {
	configFingerprint,
	recordSyncedStream,
	sentMessageHashes,
	sentMessages,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type FakeExtension = {
	api: ExtensionAPI;
	handlers: Map<string, EventHandler[]>;
};

const sessionIds = new Set<string>();

function fakeQuery(onClose?: () => void): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {
			onClose?.();
		},
	};
}

function fakeExtension(): FakeExtension {
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
	return {
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

function createEntry(
	sessionId: string,
	onClose?: () => void,
	fingerprint = { toolsetHash: "tools-v1", systemPromptHash: "prompt-v1" },
) {
	sessionIds.add(sessionId);
	overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery(onClose) });
	return getOrCreateSession({
		senpiSessionId: sessionId,
		accountName: "default",
		modelId: "claude-test",
		...fingerprint,
		options: {},
	});
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		model: "claude-test",
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

function hashes(contextValue: Context): string[] {
	return sentMessageHashes(sentMessages(contextValue));
}

async function emitOnce(extension: FakeExtension, eventName: string, event: unknown, sessionId: string): Promise<void> {
	const handlers = extension.handlers.get(eventName) ?? [];
	expect(handlers).toHaveLength(1);
	for (const handler of handlers) await handler(event, context(sessionId));
}

async function emitTwice(
	extension: FakeExtension,
	eventName: string,
	event: unknown,
	sessionId: string,
): Promise<void> {
	const handlers = extension.handlers.get(eventName) ?? [];
	expect(handlers).toHaveLength(1);
	for (const handler of handlers) {
		await handler(event, context(sessionId));
		await handler(event, context(sessionId));
	}
}

afterEach(() => {
	for (const sessionId of sessionIds) closeSession(sessionId, "test_cleanup");
	sessionIds.clear();
	resetSessionRegistryBoundary();
});

describe("Claude SDK OAuth session registry lifecycle wiring", () => {
	it("does not continue incrementally after switching away from and back to the provider", async () => {
		let closes = 0;
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const entry = createEntry("provider-switch", () => closes++);
		const resident: Context = { messages: [{ role: "user", content: "one", timestamp: 1 }] };
		recordSyncedStream(entry, hashes(resident));

		const handlers = extension.handlers.get("model_select") ?? [];
		expect(handlers).toHaveLength(1);
		for (const handler of handlers) {
			await handler(
				{
					type: "model_select",
					model: { provider: "openai", id: "gpt-test" },
					previousModel: { provider: "claude-sdk-oauth", id: "claude-test" },
				},
				context("provider-switch"),
			);
			await handler(
				{
					type: "model_select",
					model: { provider: "claude-sdk-oauth", id: "claude-test" },
					previousModel: { provider: "openai", id: "gpt-test" },
				},
				context("provider-switch"),
			);
		}

		const current: Context = {
			messages: [
				resident.messages[0]!,
				assistant("foreign answer", 2),
				{ role: "user", content: "back on Claude", timestamp: 3 },
			],
		};
		const decision = decideNativeContinuity({
			entry: undefined,
			binding: undefined,
			currentHashes: hashes(current),
			accountName: "default",
			modelId: "claude-test",
			fingerprint: { toolsetHash: "tools-v1", systemPromptHash: "prompt-v1" },
			transcriptAvailable: true,
		});

		expect(getSession("provider-switch")).toBeUndefined();
		expect(decision).toEqual({ kind: "bootstrap" });
		expect(decision.kind).not.toBe("delta");
		expect(closes).toBe(1);
	});

	it("forks instead of continuing after an assistant-only context transformation", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const entry = createEntry("assistant-transform");
		const user1 = { role: "user" as const, content: "one", timestamp: 1 };
		const originalAssistant = assistant("the original full answer", 2);
		recordSyncedStream(entry, hashes({ messages: [user1] }));
		await emitOnce(
			extension,
			"message_update",
			{ type: "message_update", message: originalAssistant },
			entry.senpiSessionId,
		);
		await emitOnce(
			extension,
			"message_end",
			{
				type: "message_end",
				message: { ...originalAssistant, content: [{ type: "text", text: "the truncated answer" }] },
			},
			entry.senpiSessionId,
		);

		expect(getSession("assistant-transform")).toMatchObject({ pendingForkReason: "assistant_rewritten" });

		const decision = decideNativeContinuity({
			entry: {
				sdkSessionId: entry.sdkSessionId,
				accountName: entry.accountName,
				modelId: entry.modelId,
				systemPromptHash: entry.systemPromptHash,
				toolsetHash: entry.toolsetHash,
				sentCount: 2,
				sentHashes: hashes({ messages: [user1, { role: "user", content: "two", timestamp: 3 }] }),
				lastAssistantUuid: "uuid-boundary-2",
				assistantUuidByIndex: new Map([
					[1, "uuid-boundary"],
					[2, "uuid-boundary-2"],
				]),
				pendingForkReason: entry.pendingForkReason,
			},
			binding: undefined,
			currentHashes: hashes({ messages: [user1, { role: "user", content: "two", timestamp: 3 }] }),
			accountName: entry.accountName,
			modelId: entry.modelId,
			fingerprint: { systemPromptHash: entry.systemPromptHash, toolsetHash: entry.toolsetHash },
			transcriptAvailable: true,
		});

		expect(decision).toMatchObject({ kind: "fork", reason: "assistant_rewritten" });
		expect(decision.kind).not.toBe("flatten");
	});

	it("does not continue incrementally after the reasoning configuration changes", () => {
		const resident: Context = { messages: [{ role: "user", content: "one", timestamp: 1 }] };
		const initialFingerprint = configFingerprint({ maxThinkingTokens: 1_024 }, resident, "oauth-slots", "default");
		const entry = createEntry("thinking-change", undefined, initialFingerprint);
		recordSyncedStream(entry, hashes(resident));

		const decision = decideNativeContinuity({
			entry: {
				sdkSessionId: entry.sdkSessionId,
				accountName: "default",
				modelId: "claude-test",
				systemPromptHash: initialFingerprint.systemPromptHash,
				toolsetHash: initialFingerprint.toolsetHash,
				sentCount: entry.sentCount,
				sentHashes: hashes(resident),
				lastAssistantUuid: null,
				assistantUuidByIndex: entry.assistantUuidByIndex,
				pendingForkReason: null,
				taintedReason: null,
			},
			binding: undefined,
			currentHashes: hashes({
				messages: [resident.messages[0]!, { role: "user", content: "two", timestamp: 2 }],
			}),
			accountName: "default",
			modelId: "claude-test",
			fingerprint: configFingerprint({ maxThinkingTokens: 8_192 }, resident, "oauth-slots", "default"),
			transcriptAvailable: true,
		});

		expect(decision).toMatchObject({ kind: "reattach", reason: "options_changed" });
		expect(decision.kind).not.toBe("flatten");
	});

	it("records a compaction fork boundary idempotently", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry("compact-session");

		await emitTwice(extension, "session_compact", { type: "session_compact" }, "compact-session");

		expect(getSession("compact-session")).toMatchObject({ pendingForkReason: "compaction" });
	});

	it("records a fork boundary before fork idempotently", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry("fork-session");

		await emitTwice(extension, "session_before_fork", { type: "session_before_fork" }, "fork-session");

		expect(getSession("fork-session")).toMatchObject({ pendingForkReason: "fork" });
	});

	it("records tree branch boundaries without tainting", async () => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry("tree-session");

		await emitTwice(
			extension,
			"session_tree",
			{ type: "session_tree", oldLeafId: "old-leaf", newLeafId: "new-leaf" },
			"tree-session",
		);

		expect(getSession("tree-session")).toMatchObject({
			state: "STARTING",
			taintedReason: null,
			branchInfo: { oldLeafId: "old-leaf", newLeafId: "new-leaf" },
		});
	});

	it.each(["quit", "new", "resume", "fork", "reload"] as const)(
		"closes a session on %s shutdown idempotently",
		async (reason) => {
			let closes = 0;
			const extension = fakeExtension();
			registerSessionRegistry(extension.api);
			createEntry(`shutdown-${reason}`, () => closes++);

			await emitTwice(extension, "session_shutdown", { type: "session_shutdown", reason }, `shutdown-${reason}`);

			expect(getSession(`shutdown-${reason}`)).toBeUndefined();
			expect(closes).toBe(1);
		},
	);

	it("closes a session when the extension is removed idempotently", async () => {
		let closes = 0;
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry("removed-session", () => closes++);

		await emitTwice(
			extension,
			"session_extensions_removed",
			{ type: "session_extensions_removed", reason: "reload", removed: [] },
			"removed-session",
		);

		expect(getSession("removed-session")).toBeUndefined();
		expect(closes).toBe(1);
	});

	it("registers lifecycle wiring from the production extension factory", () => {
		const extension = fakeExtension();

		claudeSdkOauthExtension(extension.api);

		expect(extension.handlers.get("session_compact")).toHaveLength(1);
		expect(extension.handlers.get("session_before_fork")).toHaveLength(1);
		expect(extension.handlers.get("session_tree")).toHaveLength(1);
		expect(extension.handlers.get("model_select")).toHaveLength(1);
		expect(extension.handlers.get("thinking_level_select")).toHaveLength(1);
		expect(extension.handlers.get("message_update")).toHaveLength(1);
		expect(extension.handlers.get("message_end")).toHaveLength(1);
		expect(extension.handlers.get("session_extensions_removed")).toHaveLength(1);
		expect(extension.handlers.get("session_shutdown")).toHaveLength(2);
	});
});
