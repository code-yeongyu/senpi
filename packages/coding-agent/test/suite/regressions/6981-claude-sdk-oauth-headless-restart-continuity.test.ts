import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	BINDING_ENTRY_TYPE,
	BINDING_MARKER,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import { readStoredBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";
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
import { sentMessageHashes } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type BranchEntry = { id: string; type: string; customType?: string; data?: unknown; message?: unknown };

const SESSION_ID = "issue-6981";
const PROMPT_HASH = "1".repeat(64);
const TOOLSET_HASH = "2".repeat(64);
const temporaryDirectories: string[] = [];

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
	};
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

function sessionFixture() {
	const directory = mkdtempSync(join(tmpdir(), "issue-6981-restart-"));
	temporaryDirectories.push(directory);
	const sessionFile = join(directory, "session.jsonl");
	writeFileSync(sessionFile, "", "utf8");
	// A real `-p -c` turn persists its user message before the assistant commits,
	// and that message is what the restart record anchors its sent-prefix on.
	const userMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "turn one" }],
		timestamp: 1,
	};
	const branch: BranchEntry[] = [{ type: "message", id: "user-entry", message: userMessage }];
	return { sessionFile, branch, turnHashes: sentMessageHashes([userMessage]) };
}

function fakeExtension(branch: BranchEntry[]) {
	const handlers = new Map<string, EventHandler[]>();
	const persisted: Array<{ customType: string; data: unknown }> = [];
	const api = {
		on(event: string, handler: EventHandler): void {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown): void {
			const id = `custom-${branch.length + 1}`;
			branch.push({ type: "custom", id, customType, data });
			persisted.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { api, handlers, persisted };
}

function context(sessionFile: string, branch: BranchEntry[]): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => sessionFile,
			getBranch: () => branch,
			getLeafId: () => branch.at(-1)?.id ?? null,
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
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	resetSessionRegistryBoundary();
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.length = 0;
});

describe("issue #6981 headless restart continuity", () => {
	it("invalidates persisted continuity when the committed assistant is rewritten", async () => {
		const { sessionFile, branch, turnHashes } = sessionFixture();
		const extension = fakeExtension(branch);
		registerSessionRegistry(extension.api);
		const entry = residentEntry();
		rememberBinding(bindingFromEntry(entry, turnHashes));
		const eventContext = context(sessionFile, branch);

		await emit(
			extension.handlers,
			"message_update",
			{ type: "message_update", message: assistant("provider final") },
			eventContext,
		);
		await emit(
			extension.handlers,
			"message_end",
			{ type: "message_end", message: assistant("committed rewrite") },
			eventContext,
		);

		expect(extension.persisted).toEqual([
			{
				customType: BINDING_ENTRY_TYPE,
				data: { schemaVersion: 1, invalidated: true, reason: "assistant_rewritten" },
			},
		]);
		expect(getBinding(SESSION_ID)).toBeUndefined();
	});

	it("restores a sidecar-bound SDK lineage after a separate process starts", async () => {
		const { sessionFile, branch, turnHashes } = sessionFixture();
		const extension = fakeExtension(branch);
		registerSessionRegistry(extension.api);
		const entry = residentEntry();
		rememberBinding(bindingFromEntry(entry, turnHashes));
		const eventContext = context(sessionFile, branch);

		await emit(extension.handlers, "message_end", { type: "message_end", message: assistant() }, eventContext);
		branch.push({ type: "message", id: "assistant-entry", message: assistant() });

		expect(extension.persisted).toEqual([{ customType: BINDING_ENTRY_TYPE, data: BINDING_MARKER }]);
		expect(await readStoredBinding(sessionFile)).toMatchObject({
			sessionId: SESSION_ID,
			sdkSessionId: entry.sdkSessionId,
			sentCount: 1,
		});

		closeSession(SESSION_ID, "process_exit");
		forgetBinding(SESSION_ID);

		const restarted = fakeExtension(branch);
		registerSessionRegistry(restarted.api);
		await emit(restarted.handlers, "session_start", { type: "session_start", reason: "resume" }, eventContext);

		const restored = getBinding(SESSION_ID);
		expect(restored).toMatchObject({
			sdkSessionId: entry.sdkSessionId,
			sentCount: 1,
			lastAssistantUuid: "assistant-uuid-1",
		});
		expect(
			decideNativeContinuity({
				entry: undefined,
				binding: restored,
				currentHashes: turnHashes,
				accountName: "default",
				modelId: "claude-test",
				fingerprint: { systemPromptHash: PROMPT_HASH, toolsetHash: TOOLSET_HASH },
				transcriptAvailable: true,
			}),
		).toMatchObject({ kind: "reattach", reason: "registry_miss" });
	});
});

function residentEntry() {
	overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
	const entry = getOrCreateSession({
		senpiSessionId: SESSION_ID,
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
		options: {},
	});
	entry.sentCount = 1;
	entry.assistantUuidByIndex.set(1, "assistant-uuid-1");
	return entry;
}
