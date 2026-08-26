import { describe, expect, it } from "vitest";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import { sentHashPrefixDigest } from "../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";

/**
 * Shadowing guards for the issue #723 retry checkpoint branch: it must fire ONLY
 * for a re-send of the exact turn that was left un-answered, and must never
 * outrank the fail-closed checks that precede it.
 */

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

function input(overrides: Partial<ContinuityDecisionInput> = {}): ContinuityDecisionInput {
	return {
		entry: undefined,
		binding: restored({ unansweredTurnDigest: sentHashPrefixDigest(["h1", "h2", "h3"]) }),
		currentHashes: ["h1", "h2", "h3"],
		accountName: "primary",
		modelId: "claude-opus-4-5",
		fingerprint: FINGERPRINT,
		transcriptAvailable: true,
		...overrides,
	};
}

describe("claude-sdk-oauth retry checkpoint continuity", () => {
	it("ignores a stale checkpoint once the conversation moved past that turn", () => {
		const decision = decideNativeContinuity(input({ currentHashes: ["h1", "h2", "h3", "h4"] }));

		expect(decision).toMatchObject({ kind: "reattach", reason: "registry_miss", from: 2 });
	});

	it("ignores a checkpoint whose pre-turn prefix no longer matches", () => {
		const decision = decideNativeContinuity(
			input({
				binding: restored({ unansweredTurnDigest: sentHashPrefixDigest(["h1", "h2-rewritten", "h3"]) }),
				currentHashes: ["h1", "h2-rewritten", "h3"],
			}),
		);

		// Falls through to the pre-existing divergence branch, which owns this shape.
		expect(decision).toMatchObject({ kind: "fork", reason: "history_rolled_back", atUuid: "uuid-a2" });
	});

	it("ignores a checkpoint whose restored prefix digest no longer matches", () => {
		const decision = decideNativeContinuity(
			input({
				binding: restored({
					sentHashes: [],
					sentPrefixHash: sentHashPrefixDigest(["h1", "h2-elsewhere"]),
					unansweredTurnDigest: sentHashPrefixDigest(["h1", "h2", "h3"]),
				}),
			}),
		);

		expect(decision).toEqual({ kind: "flatten", reason: "sent_stream_diverged" });
	});

	it("honours a checkpoint carried on a restored prefix-digest binding", () => {
		const decision = decideNativeContinuity(
			input({
				binding: restored({
					sentHashes: [],
					sentPrefixHash: sentHashPrefixDigest(["h1", "h2"]),
					unansweredTurnDigest: sentHashPrefixDigest(["h1", "h2", "h3"]),
				}),
			}),
		);

		expect(decision).toMatchObject({ kind: "fork", atUuid: "uuid-a2", from: 2, reason: "timeout_retry" });
	});

	it("does not let a checkpoint outrank an identity drift", () => {
		expect(decideNativeContinuity(input({ modelId: "claude-sonnet-5" }))).toEqual({
			kind: "flatten",
			reason: "model_changed",
		});
		expect(decideNativeContinuity(input({ accountName: "secondary" }))).toEqual({
			kind: "flatten",
			reason: "account_changed",
		});
	});

	it("does not let a checkpoint outrank a missing transcript", () => {
		expect(decideNativeContinuity(input({ transcriptAvailable: false }))).toEqual({
			kind: "flatten",
			reason: "transcript_missing",
		});
	});

	it("never overrides a live resident entry, which owns its own decision", () => {
		const decision = decideNativeContinuity(
			input({
				entry: {
					sdkSessionId: "sdk-1",
					accountName: "primary",
					modelId: "claude-opus-4-5",
					systemPromptHash: FINGERPRINT.systemPromptHash,
					toolsetHash: FINGERPRINT.toolsetHash,
					sentCount: 2,
					sentHashes: ["h1", "h2"],
					lastAssistantUuid: "uuid-a2",
					assistantUuidByIndex: new Map([[2, "uuid-a2"]]),
					pendingForkReason: null,
				},
			}),
		);

		expect(decision).toEqual({ kind: "delta", from: 2 });
	});
});
