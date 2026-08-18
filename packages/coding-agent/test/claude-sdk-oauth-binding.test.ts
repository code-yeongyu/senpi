import { describe, expect, it } from "vitest";
import {
	BINDING_ENTRY_TYPE,
	type BindingCheckpoint,
	bindingFromCheckpoint,
	checkpointFromBinding,
	latestBindingOnBranch,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import type { ContinuityBinding } from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";

const PROMPT_HASH = "1".repeat(64);
const TOOLSET_HASH = "2".repeat(64);

function checkpoint(overrides: Partial<BindingCheckpoint> = {}): BindingCheckpoint {
	return {
		schemaVersion: 1,
		sdkSessionId: "sdk-1",
		sentCount: 2,
		sentPrefixHash: "3".repeat(64),
		lastAssistantUuid: "uuid-a2",
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
		...overrides,
	};
}

function entry(customType: string, data: unknown) {
	return { type: "custom" as const, customType, data };
}

function messageEntry(role: "assistant" | "user") {
	return { type: "message" as const, message: { role } };
}

describe("claude-sdk-oauth continuity binding", () => {
	it("reads the newest binding checkpoint on the active branch", () => {
		const branch = [
			entry(BINDING_ENTRY_TYPE, checkpoint({ sentCount: 1 })),
			messageEntry("assistant"),
			entry("unrelated", { noise: true }),
			entry(BINDING_ENTRY_TYPE, checkpoint({ sentCount: 2 })),
			messageEntry("assistant"),
		];

		expect(latestBindingOnBranch(branch)).toMatchObject({ sentCount: 2 });
	});

	it("returns nothing when the branch carries no checkpoint", () => {
		expect(latestBindingOnBranch([entry("unrelated", {})])).toBeUndefined();
	});

	it("does not restore a checkpoint before its assistant ledger entry is committed", () => {
		expect(latestBindingOnBranch([entry(BINDING_ENTRY_TYPE, checkpoint())])).toBeUndefined();
	});

	it("treats an invalidation entry as erasing the earlier checkpoint", () => {
		const branch = [
			entry(BINDING_ENTRY_TYPE, checkpoint()),
			entry(BINDING_ENTRY_TYPE, { schemaVersion: 1, invalidated: true, reason: "flatten" }),
		];

		expect(latestBindingOnBranch(branch)).toBeUndefined();
	});

	it("restores bounded restart state from a process-local binding", () => {
		const binding: ContinuityBinding = {
			senpiSessionId: "senpi-1",
			sdkSessionId: "sdk-1",
			sentCount: 2,
			sentHashes: ["hash-1", "hash-2"],
			lastAssistantUuid: "uuid-a2",
			assistantUuidByIndex: [
				[1, "uuid-a1"],
				[2, "uuid-a2"],
			],
			accountName: "primary",
			modelId: "claude-opus-4-5",
			systemPromptHash: PROMPT_HASH,
			toolsetHash: TOOLSET_HASH,
		};

		const restored = bindingFromCheckpoint("senpi-1", checkpointFromBinding(binding));

		expect(restored).toMatchObject({
			senpiSessionId: "senpi-1",
			sdkSessionId: "sdk-1",
			sentCount: 2,
			lastAssistantUuid: "uuid-a2",
			accountName: "primary",
			modelId: "claude-opus-4-5",
			systemPromptHash: PROMPT_HASH,
			toolsetHash: TOOLSET_HASH,
		});
		expect(restored.sentHashes).toEqual([]);
		expect(restored.sentPrefixHash).toMatch(/^[0-9a-f]{64}$/);
		expect(restored.assistantUuidByIndex).toEqual([[2, "uuid-a2"]]);
	});

	it("keeps persisted checkpoint size bounded as the conversation grows", () => {
		const sentCount = 10_000;
		const binding: ContinuityBinding = {
			senpiSessionId: "senpi-long",
			sdkSessionId: "sdk-long",
			sentCount,
			sentHashes: Array.from({ length: sentCount }, (_value, index) => `hash-${index}`),
			lastAssistantUuid: `uuid-${sentCount}`,
			assistantUuidByIndex: Array.from(
				{ length: sentCount },
				(_value, index) => [index + 1, `uuid-${index + 1}`] as const,
			),
			accountName: "primary",
			modelId: "claude-opus-4-5",
			systemPromptHash: PROMPT_HASH,
			toolsetHash: TOOLSET_HASH,
		};

		const persisted = checkpointFromBinding(binding);

		expect(persisted).not.toHaveProperty("sentHashes");
		expect(persisted).not.toHaveProperty("assistantUuidByIndex");
		expect(JSON.stringify(persisted).length).toBeLessThan(1_024);
	});

	it("ignores malformed checkpoints instead of restoring partial state", () => {
		expect(
			latestBindingOnBranch([entry(BINDING_ENTRY_TYPE, { ...checkpoint(), sentPrefixHash: 42 })]),
		).toBeUndefined();
	});

	it("does not fall back to an older checkpoint when the newest binding entry is malformed", () => {
		const branch = [
			entry(BINDING_ENTRY_TYPE, checkpoint({ sdkSessionId: "stale-sdk" })),
			messageEntry("assistant"),
			entry(BINDING_ENTRY_TYPE, { ...checkpoint(), sentPrefixHash: 42 }),
		];

		expect(latestBindingOnBranch(branch)).toBeUndefined();
	});

	it.each([
		["sent count is negative", checkpoint({ sentCount: -1 })],
		["prefix hash is not a SHA-256 digest", checkpoint({ sentPrefixHash: "not-a-digest" })],
		["assistant identifier is empty", checkpoint({ lastAssistantUuid: "" })],
		["account identifier exceeds the boundary", checkpoint({ accountName: "a".repeat(257) })],
	])("rejects a checkpoint when %s", (_label, malformed) => {
		expect(latestBindingOnBranch([entry(BINDING_ENTRY_TYPE, malformed)])).toBeUndefined();
	});
});
