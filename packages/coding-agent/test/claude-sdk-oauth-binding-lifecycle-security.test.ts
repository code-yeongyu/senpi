import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "../src/core/extensions/builtin/claude-sdk-oauth/account-management.ts";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { BINDING_ENTRY_TYPE } from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import {
	bindingSidecarPath,
	type StoredBinding,
	writeStoredBinding,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";
import {
	type ContinuityBinding,
	forgetBinding,
	getBinding,
	rememberBinding,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

const SYSTEM_PROMPT_HASH = "1".repeat(64);
const TOOLSET_HASH = "2".repeat(64);
const sessionIds = new Set<string>();
const tempDirs = new Set<string>();

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
	};
}

function binding(senpiSessionId: string, sdkSessionId: string): ContinuityBinding {
	return {
		senpiSessionId,
		sdkSessionId,
		sentCount: 1,
		sentHashes: ["hash-1"],
		lastAssistantUuid: "assistant-1",
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: SYSTEM_PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
	};
}

function storedBinding(sessionFile: string, sessionId: string, sdkSessionId: string): StoredBinding {
	return {
		schemaVersion: 1,
		sessionPath: sessionFile,
		sessionId,
		markerEntryId: "marker-1",
		sdkSessionId,
		sentCount: 1,
		sentPrefixHash: "3".repeat(64),
		assistantContentHash: "4".repeat(64),
		lastAssistantUuid: "assistant-1",
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: SYSTEM_PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
	};
}

function makeSession(branch: unknown[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "binding-lifecycle-"));
	tempDirs.add(dir);
	const sessionFile = join(dir, "session.jsonl");
	return { sessionFile, branch };
}

function fakeExtension() {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const persisted: Array<{ customType: string; data: unknown }> = [];
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown): void {
			persisted.push({ customType, data });
		},
	} as ExtensionAPI;
	return { api, handlers, persisted };
}

function context(sessionId: string, branch: unknown[], sessionFile: string): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
			getSessionFile: () => sessionFile,
		},
	} as ExtensionContext;
}

function createEntry(sessionId: string): ReturnType<typeof getOrCreateSession> {
	sessionIds.add(sessionId);
	overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
	return getOrCreateSession({
		senpiSessionId: sessionId,
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: SYSTEM_PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
		options: {},
	});
}

function nonClaudeModel(): Model<"openai"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai",
		provider: "openai",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: CLAUDE_SDK_OAUTH_PROVIDER_ID,
		provider: CLAUDE_SDK_OAUTH_PROVIDER_ID,
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
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>,
	eventName: string,
	event: unknown,
	ctx: ExtensionContext,
): Promise<void> {
	const registered = handlers.get(eventName) ?? [];
	expect(registered).toHaveLength(1);
	for (const handler of registered) await handler(event, ctx);
}

afterEach(() => {
	for (const id of sessionIds) {
		closeSession(id, "test_cleanup");
		forgetBinding(id);
	}
	sessionIds.clear();
	resetSessionRegistryBoundary();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs.clear();
});

describe("Claude SDK OAuth binding lifecycle security", () => {
	it("forgets process binding and invalidates/deletes durable state when selecting a non-Claude provider", async () => {
		const sessionId = "model-select-non-claude";
		const { sessionFile } = makeSession();
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry(sessionId);
		rememberBinding(binding(sessionId, "sdk-before-switch"));
		await writeStoredBinding(sessionFile, storedBinding(sessionFile, sessionId, "sdk-before-switch"));

		await emit(
			extension.handlers,
			"model_select",
			{
				type: "model_select",
				model: nonClaudeModel(),
				previousModel: undefined,
				source: "set",
				systemPrompt: "",
				systemPromptOptions: {},
			},
			context(sessionId, [], sessionFile),
		);

		expect(getBinding(sessionId)).toBeUndefined();
		expect(extension.persisted).toContainEqual({
			customType: BINDING_ENTRY_TYPE,
			data: { schemaVersion: 1, invalidated: true, reason: "model_selected" },
		});
		expect(existsSync(bindingSidecarPath(sessionFile))).toBe(false);
	});

	it("forgets process state and deletes durable state when an assistant message is rewritten", async () => {
		const sessionId = "assistant-rewrite";
		const { sessionFile } = makeSession();
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		createEntry(sessionId);
		rememberBinding(binding(sessionId, "sdk-before-rewrite"));
		await writeStoredBinding(sessionFile, storedBinding(sessionFile, sessionId, "sdk-before-rewrite"));

		const original = assistantMessage("original answer");
		const rewritten = assistantMessage("rewritten answer");
		await emit(
			extension.handlers,
			"message_update",
			{ type: "message_update", message: original },
			context(sessionId, [], sessionFile),
		);
		await emit(
			extension.handlers,
			"message_end",
			{ type: "message_end", message: rewritten },
			context(sessionId, [], sessionFile),
		);

		expect(getBinding(sessionId)).toBeUndefined();
		expect(extension.persisted).toContainEqual({
			customType: BINDING_ENTRY_TYPE,
			data: { schemaVersion: 1, invalidated: true, reason: "assistant_rewritten" },
		});
		expect(existsSync(bindingSidecarPath(sessionFile))).toBe(false);
	});
});
