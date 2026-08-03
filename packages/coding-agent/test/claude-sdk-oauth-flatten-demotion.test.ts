import { afterEach, describe, expect, it } from "vitest";
import { decideNativeContinuity } from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import { forgetBinding } from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";

const FINGERPRINT = { systemPromptHash: "prompt-v1", toolsetHash: "tools-v1" };

function resident(overrides: Record<string, unknown> = {}) {
	return {
		sdkSessionId: "sdk-1",
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: FINGERPRINT.systemPromptHash,
		toolsetHash: FINGERPRINT.toolsetHash,
		sentCount: 3,
		sentHashes: ["h1", "h2", "h3"],
		lastAssistantUuid: "uuid-a3",
		assistantUuidByIndex: new Map([
			[1, "uuid-a1"],
			[2, "uuid-a2"],
			[3, "uuid-a3"],
		]),
		pendingForkReason: null,
		taintedReason: null,
		...overrides,
	};
}

function decide(overrides: Record<string, unknown> = {}) {
	return decideNativeContinuity({
		entry: resident(),
		binding: undefined,
		currentHashes: ["h1", "h2", "h3", "h4"],
		accountName: "primary",
		modelId: "claude-opus-4-5",
		fingerprint: FINGERPRINT,
		transcriptAvailable: true,
		...overrides,
	} as Parameters<typeof decideNativeContinuity>[0]);
}

afterEach(() => forgetBinding("flatten-demotion"));

describe("claude-sdk-oauth flatten demotion", () => {
	it("never flattens a live session across every divergence class", () => {
		const decisions = [
			decide(),
			decide({ accountName: "secondary" }),
			decide({ modelId: "claude-sonnet-5" }),
			decide({ fingerprint: { systemPromptHash: "changed", toolsetHash: "tools-v1" } }),
			decide({ entry: resident({ pendingForkReason: "compaction" }) }),
			decide({ entry: resident({ taintedReason: "abort" }) }),
			decide({ currentHashes: ["h1", "h2"] }),
			decide({ currentHashes: ["h1", "changed", "h3"] }),
		];

		expect(decisions.map((decision) => decision.kind)).not.toContain("flatten");
	});

	it("flattens only when no transcript remains to resume", () => {
		expect(decide({ entry: undefined, transcriptAvailable: false })).toEqual({
			kind: "bootstrap",
		});

		const orphanedBinding = decide({
			entry: undefined,
			transcriptAvailable: false,
			binding: {
				sdkSessionId: "sdk-gone",
				sentCount: 3,
				sentHashes: ["h1", "h2", "h3"],
				lastAssistantUuid: "uuid-a3",
				accountName: "primary",
				modelId: "claude-opus-4-5",
				systemPromptHash: FINGERPRINT.systemPromptHash,
				toolsetHash: FINGERPRINT.toolsetHash,
			},
		});

		expect(orphanedBinding).toEqual({ kind: "flatten", reason: "transcript_missing" });
	});

	it("keeps a delta for the ordinary next turn", () => {
		expect(decide()).toEqual({ kind: "delta", from: 3 });
	});
});
