import { describe, expect, it } from "vitest";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";

/**
 * senpi#1974: a legacy (no `sentPrefixHash`) binding fork must anchor its UUID
 * and its re-send offset on the SAME mapped boundary - the newest assistant
 * whose index lies inside the hash-proven shared prefix. When no mapped
 * boundary exists inside that prefix, the lineage cannot be trusted and the
 * decision fails closed to a flatten instead of pairing the binding's newest
 * assistant with a smaller offset.
 */

const FINGERPRINT = { systemPromptHash: "prompt-v1", toolsetHash: "tools-v1" };

function detached(overrides: Partial<NonNullable<ContinuityDecisionInput["binding"]>> = {}) {
	return {
		sdkSessionId: "sdk-1",
		sentCount: 4,
		sentHashes: ["h1", "h2", "h3", "h4"],
		lastAssistantUuid: "a4",
		assistantUuidByIndex: [
			[2, "a2"],
			[4, "a4"],
		],
		sdkSessionIdConfirmed: true,
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: FINGERPRINT.systemPromptHash,
		toolsetHash: FINGERPRINT.toolsetHash,
		...overrides,
	} satisfies NonNullable<ContinuityDecisionInput["binding"]>;
}

function input(overrides: Partial<ContinuityDecisionInput> = {}): ContinuityDecisionInput {
	return {
		entry: undefined,
		binding: detached(),
		currentHashes: ["h1", "h2", "x3", "x4"],
		accountName: "primary",
		modelId: "claude-opus-4-5",
		fingerprint: FINGERPRINT,
		transcriptAvailable: true,
		crossAccountResumeSupported: true,
		...overrides,
	};
}

describe("claude-sdk-oauth legacy binding fork pairing (senpi#1974)", () => {
	it("forks at the newest boundary inside the shared prefix, not at the binding's newest assistant", () => {
		const decision = decideNativeContinuity(input());

		expect(decision).toEqual({
			kind: "fork",
			sdkSessionId: "sdk-1",
			atUuid: "a2",
			from: 2,
			reason: "history_rolled_back",
		});
	});

	it("flattens when no mapped boundary lies inside the shared prefix", () => {
		const decision = decideNativeContinuity(input({ binding: detached({ assistantUuidByIndex: [[4, "a4"]] }) }));

		expect(decision).toEqual({ kind: "flatten", reason: "history_rolled_back" });
	});
});
