import { beforeEach, describe, expect, it } from "vitest";
import {
	BINDING_ENTRY_TYPE,
	forgetCheckpoint,
	latestBindingOnBranch,
	rememberCheckpoint,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import { forgetBinding, getBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import type { ClaudeSdkOauthSessionEntry } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { checkpointFromEntry } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import { rehydrateBindingFromCheckpoint } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-stream.ts";
import { prefixDigest } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";

const SESSION = "senpi-session-808";
const FINGERPRINT = { systemPromptHash: "sp-1", toolsetHash: "ts-1" };
const HASHES = ["h0", "h1", "h2", "h3"];

function entryLike(overrides: Partial<ClaudeSdkOauthSessionEntry> = {}): ClaudeSdkOauthSessionEntry {
	return {
		senpiSessionId: SESSION,
		sdkSessionId: "sdk-808",
		sentCount: 3,
		syncedPrefixHash: prefixDigest(HASHES, 3),
		assistantUuidByIndex: new Map([[3, "uuid-a3"]]),
		accountName: "primary",
		modelId: "claude-opus-5",
		systemPromptHash: FINGERPRINT.systemPromptHash,
		toolsetHash: FINGERPRINT.toolsetHash,
		...overrides,
	} as ClaudeSdkOauthSessionEntry;
}

function branchWith(data: unknown) {
	return [{ type: "custom" as const, customType: BINDING_ENTRY_TYPE, data }];
}

/** Restores the pre-turn state: both stores are module-level singletons. */
function reset(): void {
	forgetCheckpoint(SESSION);
	forgetBinding(SESSION);
}

describe("issue #808 - continuity binding survives a restart", () => {
	beforeEach(reset);

	it("derives a checkpoint from a synced entry and recovers it from the branch", () => {
		const checkpoint = checkpointFromEntry(entryLike());
		expect(checkpoint).toMatchObject({
			sdkSessionId: "sdk-808",
			sentCount: 3,
			sentPrefixHash: prefixDigest(HASHES, 3),
			lastAssistantUuid: "uuid-a3",
			systemPromptHash: "sp-1",
			toolsetHash: "ts-1",
		});

		expect(latestBindingOnBranch(branchWith(checkpoint))).toMatchObject({ sdkSessionId: "sdk-808" });
	});

	it("writes no checkpoint before the first stream is synced", () => {
		expect(checkpointFromEntry(entryLike({ syncedPrefixHash: null }))).toBeUndefined();
	});

	it("rebuilds the in-memory binding when the sent prefix still matches", () => {
		const checkpoint = checkpointFromEntry(entryLike());
		if (!checkpoint) throw new Error("checkpoint must exist");
		rememberCheckpoint(SESSION, checkpoint);

		expect(getBinding(SESSION)).toBeUndefined();
		expect(rehydrateBindingFromCheckpoint(SESSION, HASHES, FINGERPRINT, "primary", "claude-opus-5")).toBe(true);
		expect(getBinding(SESSION)).toMatchObject({
			sdkSessionId: "sdk-808",
			sentCount: 3,
			sentHashes: ["h0", "h1", "h2"],
			lastAssistantUuid: "uuid-a3",
		});
	});

	it.each([
		["a rewritten prefix", ["h0", "CHANGED", "h2", "h3"], FINGERPRINT, "primary", "claude-opus-5"],
		["a truncated history", ["h0", "h1"], FINGERPRINT, "primary", "claude-opus-5"],
		["a changed system prompt", HASHES, { ...FINGERPRINT, systemPromptHash: "sp-2" }, "primary", "claude-opus-5"],
		["a changed toolset", HASHES, { ...FINGERPRINT, toolsetHash: "ts-2" }, "primary", "claude-opus-5"],
		["a different account", HASHES, FINGERPRINT, "secondary", "claude-opus-5"],
		["a different model", HASHES, FINGERPRINT, "primary", "claude-opus-4-5"],
	])("refuses to rehydrate on %s", (_label, hashes, fingerprint, accountName, modelId) => {
		const checkpoint = checkpointFromEntry(entryLike());
		if (!checkpoint) throw new Error("checkpoint must exist");
		rememberCheckpoint(SESSION, checkpoint);

		expect(rehydrateBindingFromCheckpoint(SESSION, hashes, fingerprint, accountName, modelId)).toBe(false);
		expect(getBinding(SESSION)).toBeUndefined();
	});

	it("refuses a checkpoint written before config identity was recorded", () => {
		const checkpoint = checkpointFromEntry(entryLike());
		if (!checkpoint) throw new Error("checkpoint must exist");
		rememberCheckpoint(SESSION, { ...checkpoint, systemPromptHash: undefined, toolsetHash: undefined });

		expect(rehydrateBindingFromCheckpoint(SESSION, HASHES, FINGERPRINT, "primary", "claude-opus-5")).toBe(false);
		expect(getBinding(SESSION)).toBeUndefined();
	});

	it("consumes the checkpoint so a later turn cannot replay it", () => {
		const checkpoint = checkpointFromEntry(entryLike());
		if (!checkpoint) throw new Error("checkpoint must exist");
		rememberCheckpoint(SESSION, checkpoint);

		expect(rehydrateBindingFromCheckpoint(SESSION, HASHES, FINGERPRINT, "primary", "claude-opus-5")).toBe(true);
		forgetBinding(SESSION);
		expect(rehydrateBindingFromCheckpoint(SESSION, HASHES, FINGERPRINT, "primary", "claude-opus-5")).toBe(false);
	});
});
