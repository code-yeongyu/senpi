import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	BINDING_ENTRY_TYPE,
	BINDING_MARKER,
	bindingFromStoredBranch,
	sentHashesFromBranch,
	storedBindingFromEntry,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import type { StoredBinding } from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";
import { assistantContentHash } from "../src/core/extensions/builtin/claude-sdk-oauth/session-commit-boundary.ts";
import { sentMessageHashes, sentMessages } from "../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";

const PROMPT_HASH = "1".repeat(64);
const TOOLSET_HASH = "2".repeat(64);

function assistant(text = "committed assistant"): AssistantMessage {
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

function stored(overrides: Partial<StoredBinding> = {}): StoredBinding {
	return {
		schemaVersion: 1,
		sessionPath: "/tmp/session.jsonl",
		sessionId: "senpi-1",
		markerEntryId: "marker-1",
		sdkSessionId: "sdk-1",
		sentCount: 2,
		sentPrefixHash: "3".repeat(64),
		assistantContentHash: assistantContentHash(assistant()),
		lastAssistantUuid: "uuid-a2",
		accountName: "primary",
		modelId: "claude-test",
		systemPromptHash: PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
		...overrides,
	};
}

function marker(id = "marker-1") {
	return { type: "custom" as const, id, customType: BINDING_ENTRY_TYPE, data: BINDING_MARKER };
}

function assistantEntry(message = assistant()) {
	return { type: "message" as const, id: "assistant-entry", message };
}

describe("claude-sdk-oauth stored binding anchor", () => {
	it("restores only when the sidecar marker and committed assistant match", () => {
		const restored = bindingFromStoredBranch([marker(), assistantEntry()], stored());

		expect(restored).toMatchObject({
			senpiSessionId: "senpi-1",
			sdkSessionId: "sdk-1",
			sentCount: 2,
		});
	});

	it("rejects a sidecar whose marker is not on the active branch", () => {
		expect(bindingFromStoredBranch([marker("other"), assistantEntry()], stored())).toBeUndefined();
	});

	it("does not treat a legacy custom-entry checkpoint as trusted authority", () => {
		const legacy = {
			type: "custom" as const,
			id: "marker-1",
			customType: BINDING_ENTRY_TYPE,
			data: { schemaVersion: 1, sdkSessionId: "attacker-selected-lineage" },
		};

		expect(bindingFromStoredBranch([legacy, assistantEntry()], stored())).toBeUndefined();
	});

	it("rejects a sidecar whose adjacent committed assistant changed", () => {
		expect(bindingFromStoredBranch([marker(), assistantEntry(assistant("rewritten"))], stored())).toBeUndefined();
	});

	it("rejects an anchor followed by later conversation context", () => {
		const branch = [
			marker(),
			assistantEntry(),
			{ type: "message" as const, id: "later-user", message: { role: "user" as const } },
		];

		expect(bindingFromStoredBranch(branch, stored())).toBeUndefined();
	});

	it("allows known non-context metadata after the committed assistant", () => {
		const branch = [
			marker(),
			assistantEntry(),
			{ type: "custom" as const, id: "stop-state", customType: "senpi.hooks.stop-state", data: {} },
			{ type: "custom" as const, id: "rules-scan", customType: "pi-rules.scan", data: {} },
		];

		expect(bindingFromStoredBranch(branch, stored())).toMatchObject({ sdkSessionId: "sdk-1" });
	});

	it("rejects unknown custom metadata after the committed assistant", () => {
		const branch = [
			marker(),
			assistantEntry(),
			{ type: "custom" as const, id: "unknown", customType: "unknown-extension-state", data: {} },
		];

		expect(bindingFromStoredBranch(branch, stored())).toBeUndefined();
	});

	it("rejects a sidecar when a newer invalidation exists", () => {
		const branch = [
			marker(),
			assistantEntry(),
			{
				type: "custom" as const,
				id: "invalidation",
				customType: BINDING_ENTRY_TYPE,
				data: { schemaVersion: 1, invalidated: true, reason: "fork" },
			},
		];

		expect(bindingFromStoredBranch(branch, stored())).toBeUndefined();
	});

	it("refuses to derive hashes across a compaction boundary", () => {
		// The branch walk is not compaction-aware, while admission compares against
		// the compaction-truncated context. Deriving here would inflate sentCount and
		// flatten every later restart, so refuse to anchor at all.
		const message = { role: "user" as const, content: [{ type: "text" as const, text: "before" }], timestamp: 1 };

		expect(
			sentHashesFromBranch([
				{ type: "message", id: "u1", message },
				{ type: "compaction", id: "c1" },
				{ type: "message", id: "u2", message },
			] as never),
		).toEqual([]);
	});

	it("derives branch hashes exactly as the context path does", () => {
		// A content-less user message is skipped when the provider builds its sent
		// stream; if only one side skips it, every later index shifts and a restart
		// reports a false divergence.
		const transmitted = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "real turn" }],
			timestamp: 1,
		};
		const contentless = { role: "user" as const, content: [], timestamp: 2 };

		const fromBranch = sentHashesFromBranch([
			{ type: "message", id: "u1", message: transmitted },
			{ type: "message", id: "u2", message: contentless },
		] as never);
		const fromContext = sentMessageHashes(sentMessages({ messages: [transmitted, contentless] } as never));

		expect(fromBranch).toEqual(fromContext);
		expect(fromBranch).toHaveLength(1);
	});

	it("keeps the sidecar fixed-size when the conversation grows", () => {
		const sentCount = 10_000;
		const hashes = Array.from({ length: sentCount }, (_value, index) => `hash-${index}`);

		const checkpoint = storedBindingFromEntry(
			{
				sdkSessionId: "sdk-long",
				accountName: "primary",
				modelId: "claude-test",
				systemPromptHash: PROMPT_HASH,
				toolsetHash: TOOLSET_HASH,
				assistantUuidByIndex: new Map([[sentCount, `uuid-${sentCount}`]]),
			},
			hashes,
			{
				sessionPath: "/tmp/session.jsonl",
				sessionId: "senpi-long",
				markerEntryId: "marker-1",
				assistantContentHash: assistantContentHash(assistant()),
			},
		);

		expect(checkpoint.sentCount).toBe(sentCount);
		expect(checkpoint.lastAssistantUuid).toBe(`uuid-${sentCount}`);
		expect(checkpoint).not.toHaveProperty("sentHashes");
		expect(checkpoint).not.toHaveProperty("assistantUuidByIndex");
		expect(JSON.stringify(checkpoint).length).toBeLessThan(1_024);
	});
});
