import { afterEach, describe, expect, it } from "vitest";
import { readStoredBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-binding-store.ts";
import { decideNativeContinuity } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import { forgetBinding, getBinding } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import {
	sentHashPrefixDigest,
	sentMessageHashes,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";
import {
	assistant,
	cleanupRestartFixture,
	context,
	emit,
	fakeExtension,
	PROMPT_HASH,
	projectedHashes,
	residentEntry,
	SESSION_ID,
	sessionFixture,
	TOOLSET_HASH,
} from "../../helpers/claude-sdk-oauth-restart-fixture.ts";

afterEach(() => {
	cleanupRestartFixture();
});

describe("issue #6981 compaction restart continuity", () => {
	it("persists the admission projection and reattaches after compaction", async () => {
		const { sessionFile, branch } = sessionFixture();
		// A compacted branch with real firstKeptEntryId semantics: the first user turn
		// is summarised away, "kept-user" (BEFORE the boundary) survives verbatim
		// because the compaction names it, and one user turn follows the boundary.
		branch.push(
			{
				type: "message",
				id: "kept-user",
				message: {
					role: "user" as const,
					content: [{ type: "text" as const, text: "kept verbatim" }],
					timestamp: 2,
				},
			},
			{
				type: "compaction",
				id: "compaction-entry",
				summary: "Earlier work summarized.",
				firstKeptEntryId: "kept-user",
				tokensBefore: 200_000,
				timestamp: 3,
			},
			{
				type: "message",
				id: "current-user",
				message: {
					role: "user" as const,
					content: [{ type: "text" as const, text: "after compaction" }],
					timestamp: 4,
				},
			},
		);
		const extension = fakeExtension(branch);
		registerSessionRegistry(extension.api);
		const entry = residentEntry();
		const eventContext = context(sessionFile, branch);
		// The wiring must persist exactly what the next admission computes from this
		// branch through the real session-manager projection: summary, the kept
		// pre-boundary user, and the post-boundary user - and NOT the summarised turn.
		const expectedHashes = projectedHashes(branch);
		expect(expectedHashes).toHaveLength(3);
		const summarisedTurn = sentMessageHashes([
			{ role: "user", content: [{ type: "text", text: "turn one" }], timestamp: 1 },
		]);
		expect(expectedHashes).not.toContain(summarisedTurn[0]);

		await emit(extension.handlers, "message_end", { type: "message_end", message: assistant() }, eventContext);

		const stored = await readStoredBinding(sessionFile);
		expect(stored).toMatchObject({
			sessionId: SESSION_ID,
			sdkSessionId: entry.sdkSessionId,
			sentCount: expectedHashes.length,
			sentPrefixHash: sentHashPrefixDigest(expectedHashes),
		});

		// The lifecycle appends the committed assistant after the marker; a fresh
		// process then restores the sidecar and admission reattaches at that prefix.
		branch.push({ type: "message", id: "assistant-entry", message: assistant() });
		closeSession(SESSION_ID, "process_exit");
		forgetBinding(SESSION_ID);
		const restarted = fakeExtension(branch);
		registerSessionRegistry(restarted.api);
		await emit(restarted.handlers, "session_start", { type: "session_start", reason: "resume" }, eventContext);
		const restored = getBinding(SESSION_ID);
		expect(
			decideNativeContinuity({
				entry: undefined,
				binding: restored,
				currentHashes: projectedHashes(branch),
				accountName: "default",
				modelId: "claude-test",
				fingerprint: { systemPromptHash: PROMPT_HASH, toolsetHash: TOOLSET_HASH },
				transcriptAvailable: true,
			}),
		).toMatchObject({ kind: "reattach", reason: "registry_miss" });
	});
});
