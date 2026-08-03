import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "../src/core/extensions/builtin/claude-sdk-oauth/account-management.ts";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { forgetBinding, getBinding } from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
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

const SESSION_ID = "model-switch-session";
const modelCalls: Array<string | undefined> = [];

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
		setModel: async (model?: string) => {
			modelCalls.push(model);
		},
	} as SdkQueryHandle;
}

function fakeExtension(): { api: ExtensionAPI; handlers: Map<string, EventHandler[]> } {
	const handlers = new Map<string, EventHandler[]>();
	const api = {
		on(event: string, handler: EventHandler): void {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getFlag: () => undefined,
		registerFlag() {},
		registerCommand() {},
		registerProvider() {},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

const ctx = { sessionManager: { getSessionId: () => SESSION_ID } } as unknown as ExtensionContext;

async function emit(handlers: Map<string, EventHandler[]>, event: string, payload: unknown): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

function seed() {
	return getOrCreateSession({
		senpiSessionId: SESSION_ID,
		accountName: "primary",
		modelId: "claude-opus-4-5",
		toolsetHash: "tools",
		systemPromptHash: "prompt",
		options: {} as never,
	});
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	modelCalls.length = 0;
	resetSessionRegistryBoundary();
});

describe("claude-sdk-oauth model and thinking switches", () => {
	it("switches models on the live query without starting a new session", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const { api, handlers } = fakeExtension();
		registerSessionRegistry(api);
		const entry = seed();
		const sdkSessionId = entry.sdkSessionId;

		await emit(handlers, "model_select", {
			type: "model_select",
			model: { id: "claude-sonnet-5", provider: CLAUDE_SDK_OAUTH_PROVIDER_ID },
			previousModel: { id: "claude-opus-4-5", provider: CLAUDE_SDK_OAUTH_PROVIDER_ID },
		});

		expect(modelCalls).toEqual(["claude-sonnet-5"]);
		expect(getSession(SESSION_ID)?.sdkSessionId).toBe(sdkSessionId);
		expect(getSession(SESSION_ID)?.modelId).toBe("claude-sonnet-5");
	});

	it("tears the session down when the model leaves this provider", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const { api, handlers } = fakeExtension();
		registerSessionRegistry(api);
		seed();

		await emit(handlers, "model_select", {
			type: "model_select",
			model: { id: "gpt-5.6", provider: "openai" },
			previousModel: { id: "claude-opus-4-5", provider: CLAUDE_SDK_OAUTH_PROVIDER_ID },
		});

		expect(modelCalls).toEqual([]);
		expect(getSession(SESSION_ID)).toBeUndefined();
	});

	it("keeps the binding for reattach when the thinking level changes", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		const { api, handlers } = fakeExtension();
		registerSessionRegistry(api);
		const entry = seed();
		const sdkSessionId = entry.sdkSessionId;

		await emit(handlers, "thinking_level_select", { type: "thinking_level_select", level: "high" });

		expect(getSession(SESSION_ID)).toBeUndefined();
		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId });
	});
});
