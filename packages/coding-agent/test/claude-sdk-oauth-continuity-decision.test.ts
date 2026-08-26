import { describe, expect, it } from "vitest";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import { sentHashPrefixDigest } from "../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";

const FINGERPRINT = { systemPromptHash: "prompt-v1", toolsetHash: "tools-v1" };

function restored(overrides: Partial<NonNullable<ContinuityDecisionInput["binding"]>> = {}) {
	return {
		sdkSessionId: "sdk-1",
		sentCount: 2,
		sentHashes: ["h1", "h2"],
		lastAssistantUuid: "uuid-a2",
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: FINGERPRINT.systemPromptHash,
		toolsetHash: FINGERPRINT.toolsetHash,
		...overrides,
	} satisfies NonNullable<ContinuityDecisionInput["binding"]>;
}

function resident(overrides: Partial<ContinuityDecisionInput["entry"]> = {}) {
	return {
		sdkSessionId: "sdk-1",
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: FINGERPRINT.systemPromptHash,
		toolsetHash: FINGERPRINT.toolsetHash,
		sentCount: 2,
		sentHashes: ["h1", "h2"],
		lastAssistantUuid: "uuid-a2",
		assistantUuidByIndex: new Map([
			[1, "uuid-a1"],
			[2, "uuid-a2"],
		]),
		pendingForkReason: null,
		...overrides,
	} satisfies ContinuityDecisionInput["entry"];
}

function input(overrides: Partial<ContinuityDecisionInput> = {}): ContinuityDecisionInput {
	return {
		entry: resident(),
		binding: undefined,
		currentHashes: ["h1", "h2", "h3"],
		accountName: "primary",
		modelId: "claude-opus-4-5",
		fingerprint: FINGERPRINT,
		transcriptAvailable: true,
		...overrides,
	};
}

describe("claude-sdk-oauth native continuity decisions", () => {
	it("sends only the delta when the live session still matches", () => {
		expect(decideNativeContinuity(input())).toEqual({ kind: "delta", from: 2 });
	});

	it("bootstraps when there is neither a live entry nor a persisted binding", () => {
		expect(decideNativeContinuity(input({ entry: undefined, binding: undefined }))).toEqual({
			kind: "bootstrap",
		});
	});

	it("reattaches to the same session when the query is gone but the binding survives", () => {
		const decision = decideNativeContinuity(
			input({
				entry: undefined,
				binding: {
					sdkSessionId: "sdk-1",
					sentCount: 2,
					sentHashes: ["h1", "h2"],
					lastAssistantUuid: "uuid-a2",
					accountName: "primary",
					modelId: "claude-opus-4-5",
					systemPromptHash: FINGERPRINT.systemPromptHash,
					toolsetHash: FINGERPRINT.toolsetHash,
				},
			}),
		);

		expect(decision).toMatchObject({ kind: "reattach", sdkSessionId: "sdk-1", from: 2 });
	});

	it("reattaches rather than flattens when the restart fingerprint changed", () => {
		const decision = decideNativeContinuity(
			input({ fingerprint: { systemPromptHash: "prompt-v2", toolsetHash: FINGERPRINT.toolsetHash } }),
		);

		expect(decision).toMatchObject({ kind: "reattach", reason: "options_changed", sdkSessionId: "sdk-1" });
	});

	it("reattaches rather than flattens when the model changed", () => {
		expect(decideNativeContinuity(input({ modelId: "claude-sonnet-5" }))).toMatchObject({
			kind: "reattach",
			reason: "model_changed",
		});
	});

	it("forks at the recorded boundary when a rewrite was committed", () => {
		const decision = decideNativeContinuity(input({ entry: resident({ pendingForkReason: "assistant_rewritten" }) }));

		expect(decision).toMatchObject({
			kind: "fork",
			reason: "assistant_rewritten",
			atUuid: "uuid-a1",
			from: 1,
		});
	});

	it("forks at the last shared boundary when history was rolled back", () => {
		const decision = decideNativeContinuity(
			input({
				entry: resident({
					sentCount: 3,
					sentHashes: ["h1", "h2", "h3"],
					lastAssistantUuid: "uuid-a3",
					assistantUuidByIndex: new Map([
						[1, "uuid-a1"],
						[2, "uuid-a2"],
						[3, "uuid-a3"],
					]),
				}),
				currentHashes: ["h1", "h2"],
			}),
		);

		expect(decision).toMatchObject({ kind: "fork", reason: "history_rolled_back", atUuid: "uuid-a1", from: 1 });
	});

	it("forks when an already-sent message was rewritten in place", () => {
		const decision = decideNativeContinuity(input({ currentHashes: ["h1", "h2-rewritten", "h3"] }));

		expect(decision).toMatchObject({ kind: "fork", reason: "sent_stream_diverged" });
	});

	it("flattens only when no transcript is available to resume", () => {
		const decision = decideNativeContinuity(
			input({
				entry: undefined,
				binding: {
					sdkSessionId: "sdk-gone",
					sentCount: 2,
					sentHashes: ["h1", "h2"],
					lastAssistantUuid: "uuid-a2",
					accountName: "primary",
					modelId: "claude-opus-4-5",
					systemPromptHash: FINGERPRINT.systemPromptHash,
					toolsetHash: FINGERPRINT.toolsetHash,
				},
				transcriptAvailable: false,
			}),
		);

		expect(decision).toEqual({ kind: "flatten", reason: "transcript_missing" });
	});

	it("never flattens while a live resident session exists with boundaries", () => {
		const kinds = [
			decideNativeContinuity(input({ accountName: "secondary" })),
			decideNativeContinuity(input({ modelId: "other" })),
			decideNativeContinuity(input({ fingerprint: { systemPromptHash: "x", toolsetHash: "y" } })),
			decideNativeContinuity(input({ entry: resident({ pendingForkReason: "compaction" }) })),
		].map((decision) => decision.kind);

		expect(kinds).not.toContain("flatten");
	});

	it("flattens with registry_miss when a diverged binding has no assistant boundary", () => {
		const decision = decideNativeContinuity(
			input({
				entry: undefined,
				binding: {
					sdkSessionId: "sdk-gone",
					sentCount: 2,
					sentHashes: ["h1", "h2"],
					lastAssistantUuid: null,
					accountName: "primary",
					modelId: "claude-opus-4-5",
					systemPromptHash: FINGERPRINT.systemPromptHash,
					toolsetHash: FINGERPRINT.toolsetHash,
				},
				transcriptAvailable: true,
				currentHashes: ["h1", "h2-rewritten", "h3"],
			}),
		);

		expect(decision).toEqual({ kind: "flatten", reason: "registry_miss" });
	});

	it("fails closed instead of pairing a restored divergence with the wrong assistant boundary", () => {
		const decision = decideNativeContinuity(
			input({
				entry: undefined,
				binding: {
					sdkSessionId: "sdk-restored",
					sentCount: 2,
					sentHashes: [],
					sentPrefixHash: sentHashPrefixDigest(["h1", "h2"]),
					lastAssistantUuid: "uuid-a2",
					accountName: "primary",
					modelId: "claude-opus-4-5",
					systemPromptHash: FINGERPRINT.systemPromptHash,
					toolsetHash: FINGERPRINT.toolsetHash,
				},
				currentHashes: ["h1", "h2-rewritten", "h3"],
			}),
		);

		expect(decision).toEqual({ kind: "flatten", reason: "sent_stream_diverged" });
	});

	it("forks at the pre-turn boundary when the same turn is retried after a timeout abort", () => {
		const decision = decideNativeContinuity(
			input({
				entry: undefined,
				binding: restored({ unansweredTurnDigest: sentHashPrefixDigest(["h1", "h2", "h3"]) }),
			}),
		);

		expect(decision).toEqual({
			kind: "fork",
			sdkSessionId: "sdk-1",
			atUuid: "uuid-a2",
			from: 2,
			reason: "timeout_retry",
		});
	});

	it("cold-seeds a retried first turn that has no assistant boundary to fork at", () => {
		const decision = decideNativeContinuity(
			input({
				entry: undefined,
				currentHashes: ["h1"],
				binding: restored({
					sentCount: 0,
					sentHashes: [],
					lastAssistantUuid: null,
					unansweredTurnDigest: sentHashPrefixDigest(["h1"]),
				}),
			}),
		);

		expect(decision).toEqual({ kind: "flatten", reason: "timeout_retry" });
	});

	it("flattens when a hash divergence has no assistant boundary to fork at", () => {
		const decision = decideNativeContinuity(
			input({
				entry: resident({ assistantUuidByIndex: new Map() }),
				currentHashes: ["h1", "h2-rewritten", "h3"],
			}),
		);

		expect(decision).toMatchObject({ kind: "flatten", reason: "sent_stream_diverged" });
	});
});
