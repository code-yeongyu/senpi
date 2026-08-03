import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "../src/core/extensions/builtin/claude-sdk-oauth/account-management.ts";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const openSessions = new Set<string>();

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
	};
}

function fakeExtension(): { api: ExtensionAPI; handlers: Map<string, EventHandler[]> } {
	const handlers = new Map<string, EventHandler[]>();
	const api = {
		on(event: string, handler: EventHandler): void {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		getFlag: () => undefined,
		registerFlag() {},
		registerCommand() {},
		registerProvider() {},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

function context(sessionId: string): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

async function emit(
	handlers: Map<string, EventHandler[]>,
	event: string,
	payload: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		provider: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		model: "claude-opus-4-5",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		...overrides,
	} as AssistantMessage;
}

function seedEntry(sessionId: string) {
	openSessions.add(sessionId);
	return getOrCreateSession({
		senpiSessionId: sessionId,
		accountName: "primary",
		modelId: "claude-opus-4-5",
		toolsetHash: "tools",
		systemPromptHash: "prompt",
		options: {} as never,
	});
}

afterEach(() => {
	for (const sessionId of openSessions) closeSession(sessionId, "test_cleanup");
	openSessions.clear();
	resetSessionRegistryBoundary();
});

describe("claude-sdk-oauth ledger authority (SDK transcript is authoritative)", () => {
	it("does not taint a result-only successful turn (no stream content events)", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const { api, handlers } = fakeExtension();
		registerSessionRegistry(api);
		const ctx = context("session-result-only");
		const entry = seedEntry("session-result-only");

		const message = assistant("answer produced only at the terminal result");
		await emit(handlers, "message_start", { message: assistant("") }, ctx);
		await emit(handlers, "message_end", { message }, ctx);

		expect(entry.taintedReason).toBeNull();
		expect(getSession("session-result-only")?.taintedReason ?? null).toBeNull();
	});

	it("records a pending fork when an extension rewrites the assistant message at commit", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const { api, handlers } = fakeExtension();
		registerSessionRegistry(api);
		const ctx = context("session-rewrite");
		const entry = seedEntry("session-rewrite");

		const provided = assistant("original streamed answer");
		await emit(handlers, "message_start", { message: provided }, ctx);
		await emit(handlers, "message_update", { message: provided }, ctx);
		await emit(handlers, "message_end", { message: assistant("remediated answer") }, ctx);

		expect(entry.pendingForkReason).toBe("assistant_rewritten");
	});

	it("keeps a plain streamed turn clean", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const { api, handlers } = fakeExtension();
		registerSessionRegistry(api);
		const ctx = context("session-clean");
		const entry = seedEntry("session-clean");

		const message = assistant("streamed answer");
		await emit(handlers, "message_start", { message }, ctx);
		await emit(handlers, "message_update", { message }, ctx);
		await emit(handlers, "message_end", { message }, ctx);

		expect(entry.taintedReason).toBeNull();
		expect(entry.pendingForkReason).toBeNull();
	});

	it("does not taint the ledger for an aborted turn", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const { api, handlers } = fakeExtension();
		registerSessionRegistry(api);
		const ctx = context("session-aborted");
		const entry = seedEntry("session-aborted");

		const aborted = assistant("partial", { stopReason: "aborted" });
		await emit(handlers, "message_start", { message: aborted }, ctx);
		await emit(handlers, "message_end", { message: aborted }, ctx);

		// An aborted turn leaves the ledger clean (no taint) — the abort →
		// pending-fork wiring is a follow-up, so the title must not promise it.
		expect(entry.taintedReason).toBeNull();
		expect(entry.pendingForkReason).toBeNull();
	});
});
