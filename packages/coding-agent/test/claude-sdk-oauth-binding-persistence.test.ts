import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { BINDING_ENTRY_TYPE, BINDING_MARKER } from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import {
	type StoredBinding,
	writeStoredBinding,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";
import { assistantContentHash } from "../src/core/extensions/builtin/claude-sdk-oauth/session-commit-boundary.ts";
import {
	type ContinuityBinding,
	forgetBinding,
	getBinding,
	rememberBinding,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const SESSION_ID = "binding-persistence";
const PROMPT_HASH = "1".repeat(64);
const TOOLSET_HASH = "2".repeat(64);
const temporaryDirectories: string[] = [];

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "committed assistant" }],
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
	const directory = mkdtempSync(join(tmpdir(), "binding-persistence-"));
	temporaryDirectories.push(directory);
	const sessionFile = join(directory, "session.jsonl");
	writeFileSync(sessionFile, "", "utf8");
	return { sessionFile };
}

function stored(sessionFile: string, markerEntryId = "marker-1"): StoredBinding {
	return {
		schemaVersion: 1,
		sessionPath: sessionFile,
		sessionId: SESSION_ID,
		markerEntryId,
		sdkSessionId: "persisted-sdk",
		sentCount: 1,
		sentPrefixHash: "3".repeat(64),
		assistantContentHash: assistantContentHash(assistant()),
		lastAssistantUuid: "assistant-1",
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
	};
}

function branch(markerEntryId = "marker-1") {
	return [
		{ type: "custom", id: markerEntryId, customType: BINDING_ENTRY_TYPE, data: BINDING_MARKER },
		{ type: "message", id: "assistant-entry", message: assistant() },
	];
}

function context(sessionFile: string, entries: ReturnType<typeof branch> | [] = branch()): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => sessionFile,
			getBranch: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
		},
	} as unknown as ExtensionContext;
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
	forgetBinding(SESSION_ID);
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
	temporaryDirectories.length = 0;
});

describe("Claude SDK OAuth persisted binding lifecycle", () => {
	it.each(["startup", "resume"] as const)("restores a trusted sidecar on %s", async (reason) => {
		const { sessionFile } = sessionFixture();
		await writeStoredBinding(sessionFile, stored(sessionFile));
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(extension.handlers, "session_start", { type: "session_start", reason }, context(sessionFile));

		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId: "persisted-sdk" });
	});

	it("does not restore a sidecar whose marker is absent", async () => {
		const { sessionFile } = sessionFixture();
		await writeStoredBinding(sessionFile, stored(sessionFile));
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "resume" },
			context(sessionFile, []),
		);

		expect(getBinding(SESSION_ID)).toBeUndefined();
	});

	it("keeps the fresher process binding on reload", async () => {
		const { sessionFile } = sessionFixture();
		const live: ContinuityBinding = {
			senpiSessionId: SESSION_ID,
			sdkSessionId: "live-sdk",
			sentCount: 1,
			sentHashes: ["hash-1"],
			lastAssistantUuid: "assistant-1",
			accountName: "default",
			modelId: "claude-test",
			systemPromptHash: PROMPT_HASH,
			toolsetHash: TOOLSET_HASH,
		};
		rememberBinding(live);
		await writeStoredBinding(sessionFile, stored(sessionFile));
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "reload" },
			context(sessionFile),
		);

		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId: "live-sdk" });
	});

	it("clears stale process state when startup has no sidecar", async () => {
		const { sessionFile } = sessionFixture();
		rememberBinding({ ...bindingFromStored(stored(sessionFile)), sdkSessionId: "stale-sdk" });
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "resume" },
			context(sessionFile),
		);

		expect(getBinding(SESSION_ID)).toBeUndefined();
	});
});

function bindingFromStored(record: StoredBinding): ContinuityBinding {
	return {
		senpiSessionId: record.sessionId,
		sdkSessionId: record.sdkSessionId,
		sentCount: record.sentCount,
		sentHashes: [],
		sentPrefixHash: record.sentPrefixHash,
		lastAssistantUuid: record.lastAssistantUuid,
		accountName: record.accountName,
		modelId: record.modelId,
		systemPromptHash: record.systemPromptHash,
		toolsetHash: record.toolsetHash,
	};
}
