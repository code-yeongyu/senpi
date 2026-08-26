import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { BINDING_ENTRY_TYPE, BINDING_MARKER } from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
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

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const PROMPT_HASH = "1".repeat(64);
const TOOLSET_HASH = "2".repeat(64);
const sessions = new Set<string>();
const directories: string[] = [];

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
	};
}

function binding(sessionId: string): ContinuityBinding {
	return {
		senpiSessionId: sessionId,
		sdkSessionId: "sdk-durable",
		sentCount: 1,
		sentHashes: ["hash-1"],
		lastAssistantUuid: "assistant-1",
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
	};
}

function stored(sessionFile: string, sessionId: string): StoredBinding {
	return {
		schemaVersion: 1,
		sessionPath: sessionFile,
		sessionId,
		markerEntryId: "marker-1",
		sdkSessionId: "sdk-durable",
		sentCount: 1,
		sentPrefixHash: "3".repeat(64),
		assistantContentHash: "4".repeat(64),
		lastAssistantUuid: "assistant-1",
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
	};
}

function sessionFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "binding-branch-lifecycle-"));
	directories.push(directory);
	return join(directory, "session.jsonl");
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

function context(sessionId: string, path: string, branch: readonly unknown[] = []): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}

async function emit(
	handlers: Map<string, EventHandler[]>,
	eventName: string,
	event: unknown,
	eventContext: ExtensionContext,
): Promise<void> {
	const registered = handlers.get(eventName) ?? [];
	expect(registered).toHaveLength(1);
	for (const handler of registered) await handler(event, eventContext);
}

afterEach(() => {
	for (const sessionId of sessions) {
		closeSession(sessionId, "test_cleanup");
		forgetBinding(sessionId);
	}
	sessions.clear();
	resetSessionRegistryBoundary();
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.length = 0;
});

describe("Claude SDK OAuth branch lifecycle binding security", () => {
	it("rejects an inherited parent binding after a fork restarts", async () => {
		const sessionId = "session-start-fork";
		const path = sessionFile();
		const branch = [
			{ type: "custom", id: "marker-1", customType: BINDING_ENTRY_TYPE, data: BINDING_MARKER },
			{ type: "message", message: { role: "assistant" } },
		];
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		rememberBinding(binding(sessionId));
		await writeStoredBinding(path, stored(path, sessionId));

		await emit(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "fork" },
			context(sessionId, path, branch),
		);

		expect(getBinding(sessionId)).toBeUndefined();
		expect(extension.persisted).toContainEqual({
			customType: BINDING_ENTRY_TYPE,
			data: { schemaVersion: 1, invalidated: true, reason: "fork" },
		});
		expect(existsSync(bindingSidecarPath(path))).toBe(false);
	});

	it.each([
		["accepted compaction", "session_compact", { type: "session_compact", accepted: true }, "compaction"],
		["tree navigation", "session_tree", { type: "session_tree", oldLeafId: "old", newLeafId: "new" }, "tree_changed"],
	] as const)("invalidates process and durable state after %s", async (_label, eventName, event, reason) => {
		const sessionId = `lifecycle-${eventName}`;
		const path = sessionFile();
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);
		sessions.add(sessionId);
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		getOrCreateSession({
			senpiSessionId: sessionId,
			accountName: "default",
			modelId: "claude-test",
			systemPromptHash: PROMPT_HASH,
			toolsetHash: TOOLSET_HASH,
			options: {},
		});
		rememberBinding(binding(sessionId));
		await writeStoredBinding(path, stored(path, sessionId));

		await emit(extension.handlers, eventName, event, context(sessionId, path));

		expect(getBinding(sessionId)).toBeUndefined();
		expect(extension.persisted).toContainEqual({
			customType: BINDING_ENTRY_TYPE,
			data: { schemaVersion: 1, invalidated: true, reason },
		});
		expect(existsSync(bindingSidecarPath(path))).toBe(false);
	});
});
