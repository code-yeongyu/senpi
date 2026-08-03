import { describe, expect, it } from "vitest";
import {
	BINDING_ENTRY_TYPE,
	type BindingCheckpoint,
	latestBindingOnBranch,
	verifyBindingAgainstTranscript,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";

function checkpoint(overrides: Partial<BindingCheckpoint> = {}): BindingCheckpoint {
	return {
		schemaVersion: 1,
		sdkSessionId: "sdk-1",
		sentCount: 2,
		sentPrefixHash: "prefix-hash",
		lastAssistantUuid: "uuid-a2",
		accountName: "primary",
		claudeConfigDir: "/home/user/.claude",
		modelId: "claude-opus-4-5",
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

	it("reattaches when the transcript still holds the recorded boundary and prefix", () => {
		const decision = verifyBindingAgainstTranscript({
			binding: checkpoint(),
			transcriptExists: true,
			transcriptHasBoundaryUuid: true,
			currentSentPrefixHash: "prefix-hash",
		});

		expect(decision).toMatchObject({ kind: "reattach", sdkSessionId: "sdk-1", from: 2 });
	});

	it("forks at the boundary when the local prefix advanced past the checkpoint", () => {
		const decision = verifyBindingAgainstTranscript({
			binding: checkpoint(),
			transcriptExists: true,
			transcriptHasBoundaryUuid: true,
			currentSentPrefixHash: "prefix-hash-moved",
		});

		expect(decision).toMatchObject({ kind: "fork", atUuid: "uuid-a2", reason: "sent_stream_diverged" });
	});

	it("flattens only when the SDK transcript is gone", () => {
		const decision = verifyBindingAgainstTranscript({
			binding: checkpoint(),
			transcriptExists: false,
			transcriptHasBoundaryUuid: false,
			currentSentPrefixHash: "prefix-hash",
		});

		expect(decision).toEqual({ kind: "flatten", reason: "transcript_missing" });
	});

	it("flattens when the boundary uuid vanished from an existing transcript", () => {
		const decision = verifyBindingAgainstTranscript({
			binding: checkpoint(),
			transcriptExists: true,
			transcriptHasBoundaryUuid: false,
			currentSentPrefixHash: "prefix-hash",
		});

		expect(decision).toMatchObject({ kind: "flatten", reason: "branch_boundary_unavailable" });
	});
});
