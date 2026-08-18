import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { BINDING_ENTRY_TYPE } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import { decideNativeContinuity } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import {
	bindingFromEntry,
	forgetBinding,
	getBinding,
	rememberBinding,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const PROMPT_HASH = "1".repeat(64);
const TOOLSET_HASH = "2".repeat(64);

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
	};
}

function fakeExtension() {
	const handlers = new Map<string, EventHandler[]>();
	const persisted: Array<{ customType: string; data: unknown }> = [];
	const api = {
		on(event: string, handler: EventHandler): void {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown): void {
			persisted.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { api, handlers, persisted };
}

function assistant(text = "turn one"): AssistantMessage {
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
		timestamp: 1,
	};
}

async function emit(
	handlers: Map<string, EventHandler[]>,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	const registered = handlers.get(eventName) ?? [];
	expect(registered).toHaveLength(1);
	for (const handler of registered) await handler(event, ctx);
}

afterEach(() => {
	closeSession("issue-6981", "test_cleanup");
	forgetBinding("issue-6981");
	resetSessionRegistryBoundary();
});

describe("issue #6981 headless restart continuity", () => {
	it("persists an invalidation when the committed assistant rewrites the provider final", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const entry = getOrCreateSession({
			senpiSessionId: "issue-6981",
			accountName: "default",
			modelId: "claude-test",
			systemPromptHash: PROMPT_HASH,
			toolsetHash: TOOLSET_HASH,
			options: {},
		});
		entry.sentCount = 1;
		entry.assistantUuidByIndex.set(1, "assistant-uuid-1");
		rememberBinding(bindingFromEntry(entry, ["user-hash-1"]));

		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const context = {
			sessionManager: {
				getSessionId: () => "issue-6981",
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;
		const providerFinal = assistant("provider final");

		await emit(extension.handlers, "message_update", { type: "message_update", message: providerFinal }, context);
		await emit(
			extension.handlers,
			"message_end",
			{ type: "message_end", message: assistant("committed rewrite") },
			context,
		);

		expect(extension.persisted).toEqual([
			{
				customType: BINDING_ENTRY_TYPE,
				data: { schemaVersion: 1, invalidated: true, reason: "assistant_rewritten" },
			},
		]);
	});

	it("persists the SDK binding in the session branch and restores it on startup", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const entry = getOrCreateSession({
			senpiSessionId: "issue-6981",
			accountName: "default",
			modelId: "claude-test",
			systemPromptHash: PROMPT_HASH,
			toolsetHash: TOOLSET_HASH,
			options: {},
		});
		entry.sentCount = 1;
		entry.assistantUuidByIndex.set(1, "assistant-uuid-1");
		rememberBinding(bindingFromEntry(entry, ["user-hash-1"]));

		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		const firstContext = {
			sessionManager: {
				getSessionId: () => "issue-6981",
				getBranch: () => [],
			},
		} as unknown as ExtensionContext;

		await emit(extension.handlers, "message_end", { type: "message_end", message: assistant() }, firstContext);

		expect(extension.persisted).toHaveLength(1);
		expect(extension.persisted[0]).toMatchObject({ customType: BINDING_ENTRY_TYPE });

		closeSession("issue-6981", "process_exit");
		forgetBinding("issue-6981");
		expect(getBinding("issue-6981")).toBeUndefined();

		const restarted = fakeExtension();
		registerSessionRegistry(restarted.api);
		const restartContext = {
			sessionManager: {
				getSessionId: () => "issue-6981",
				getBranch: () => [
					{
						type: "custom",
						customType: extension.persisted[0]!.customType,
						data: extension.persisted[0]!.data,
					},
					{ type: "message", message: assistant() },
				],
			},
		} as unknown as ExtensionContext;

		await emit(restarted.handlers, "session_start", { type: "session_start", reason: "resume" }, restartContext);

		const restored = getBinding("issue-6981");
		expect(restored).toMatchObject({
			sdkSessionId: entry.sdkSessionId,
			sentCount: 1,
			lastAssistantUuid: "assistant-uuid-1",
		});
		expect(
			decideNativeContinuity({
				entry: undefined,
				binding: restored,
				currentHashes: ["user-hash-1"],
				accountName: "default",
				modelId: "claude-test",
				fingerprint: { systemPromptHash: PROMPT_HASH, toolsetHash: TOOLSET_HASH },
				transcriptAvailable: true,
			}),
		).toMatchObject({ kind: "reattach", reason: "registry_miss" });
	});
});
