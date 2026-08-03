import { describe, expect, it } from "vitest";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";

const FINGERPRINT = { systemPromptHash: "prompt-v1", toolsetHash: "tools-v1" };

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

	it("never flattens while a live resident session exists", () => {
		const kinds = [
			decideNativeContinuity(input({ accountName: "secondary" })),
			decideNativeContinuity(input({ modelId: "other" })),
			decideNativeContinuity(input({ fingerprint: { systemPromptHash: "x", toolsetHash: "y" } })),
			decideNativeContinuity(input({ entry: resident({ pendingForkReason: "compaction" }) })),
		].map((decision) => decision.kind);

		expect(kinds).not.toContain("flatten");
	});
});
