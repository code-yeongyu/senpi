import { describe, expect, it } from "vitest";
import {
	BINDING_ENTRY_TYPE,
	type BindingCheckpoint,
	bindingFromCheckpoint,
	checkpointFromBinding,
	latestBindingOnBranch,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import type { ContinuityBinding } from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";

function checkpoint(overrides: Partial<BindingCheckpoint> = {}): BindingCheckpoint {
	return {
		schemaVersion: 1,
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
		systemPromptHash: "prompt-v1",
		toolsetHash: "tools-v1",
		...overrides,
	};
}

function entry(customType: string, data: unknown) {
	return { type: "custom" as const, customType, data };
}

describe("claude-sdk-oauth continuity binding", () => {
	it("reads the newest binding checkpoint on the active branch", () => {
		const branch = [
			entry(BINDING_ENTRY_TYPE, checkpoint({ sentCount: 1 })),
			entry("unrelated", { noise: true }),
			entry(BINDING_ENTRY_TYPE, checkpoint({ sentCount: 2 })),
		];

		expect(latestBindingOnBranch(branch)).toMatchObject({ sentCount: 2 });
	});

	it("returns nothing when the branch carries no checkpoint", () => {
		expect(latestBindingOnBranch([entry("unrelated", {})])).toBeUndefined();
	});

	it("treats an invalidation entry as erasing the earlier checkpoint", () => {
		const branch = [
			entry(BINDING_ENTRY_TYPE, checkpoint()),
			entry(BINDING_ENTRY_TYPE, { schemaVersion: 1, invalidated: true, reason: "flatten" }),
		];

		expect(latestBindingOnBranch(branch)).toBeUndefined();
	});

	it("round-trips a process-local binding through a serializable checkpoint", () => {
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
			systemPromptHash: "prompt-v1",
			toolsetHash: "tools-v1",
		};

		expect(bindingFromCheckpoint("senpi-1", checkpointFromBinding(binding))).toEqual(binding);
	});

	it("ignores malformed checkpoints instead of restoring partial state", () => {
		expect(latestBindingOnBranch([entry(BINDING_ENTRY_TYPE, { ...checkpoint(), sentHashes: [42] })])).toBeUndefined();
	});
});
