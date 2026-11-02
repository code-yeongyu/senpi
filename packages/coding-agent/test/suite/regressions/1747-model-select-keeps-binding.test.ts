import { afterEach, describe, expect, it } from "vitest";
import {
	BINDING_ENTRY_TYPE,
	BINDING_MARKER,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-binding.ts";
import { readStoredBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-binding-store.ts";
import { decideNativeContinuity } from "../../../src/core/extensions/builtin/anthropic-subscription/session-continuity.ts";
import { getBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { getSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import {
	recordSyncedStream,
	sentMessageHashes,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-sync.ts";
import {
	assistant,
	cleanupRestartFixture,
	context,
	emit,
	fakeExtension,
	PROMPT_HASH,
	residentEntry,
	SESSION_ID,
	sessionFixture,
	TOOLSET_HASH,
} from "../../helpers/anthropic-subscription-restart-fixture.ts";

/**
 * senpi#1747: leaving this provider through the model selector must close the live
 * SDK session and KEEP the binding, exactly like a thinking-level change. Destroying
 * it made the return trip re-send the whole conversation.
 */

const FINGERPRINT = { systemPromptHash: PROMPT_HASH, toolsetHash: TOOLSET_HASH };

function selectModel(provider: string, id: string) {
	return {
		type: "model_select",
		model: { id, provider },
		previousModel: { id: "claude-test", provider: "anthropic-subscription" },
	};
}

/** A committed turn: the marker plus the sidecar a later process would restore from. */
async function committedTurn() {
	const fixture = sessionFixture();
	const extension = fakeExtension(fixture.branch);
	registerSessionRegistry(extension.api);
	const entry = residentEntry();
	recordSyncedStream(entry, fixture.turnHashes);
	const eventContext = context(fixture.sessionFile, fixture.branch);
	await emit(extension.handlers, "message_end", { type: "message_end", message: assistant() }, eventContext);
	fixture.branch.push({ type: "message", id: "assistant-entry", message: assistant() });
	return { ...fixture, extension, eventContext, sdkSessionId: entry.sdkSessionId };
}

afterEach(() => {
	cleanupRestartFixture();
});

describe("issue #1747 model selector keeps a resumable Claude binding", () => {
	it("keeps the binding and the sidecar when the selected model leaves this provider", async () => {
		const turn = await committedTurn();
		expect(await readStoredBinding(turn.sessionFile)).toMatchObject({ sdkSessionId: turn.sdkSessionId });

		await emit(turn.extension.handlers, "model_select", selectModel("openai", "gpt-5.6"), turn.eventContext);

		expect(getSession(SESSION_ID)).toBeUndefined();
		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId: turn.sdkSessionId, sentCount: 1 });
		expect(await readStoredBinding(turn.sessionFile)).toMatchObject({ sdkSessionId: turn.sdkSessionId });
		expect(turn.extension.persisted).toEqual([{ customType: BINDING_ENTRY_TYPE, data: BINDING_MARKER }]);
	});

	it("reattaches at the recorded prefix when the same Claude model is selected again", async () => {
		const turn = await committedTurn();

		await emit(turn.extension.handlers, "model_select", selectModel("openai", "gpt-5.6"), turn.eventContext);
		await emit(
			turn.extension.handlers,
			"model_select",
			selectModel("anthropic-subscription", "claude-test"),
			turn.eventContext,
		);

		// The excursion answered one turn on the other provider before coming back; the
		// sent stream carries user turns only, so that answer adds nothing to it.
		const awayHashes = sentMessageHashes([
			...turn.contextMessages,
			{ role: "user", content: [{ type: "text", text: "back on Claude" }], timestamp: 3 },
		]);
		const decision = decideNativeContinuity({
			entry: undefined,
			binding: getBinding(SESSION_ID),
			currentHashes: awayHashes,
			accountName: "default",
			modelId: "claude-test",
			fingerprint: FINGERPRINT,
			transcriptAvailable: true,
			crossAccountResumeSupported: true,
		});

		// The recorded prefix still matches, so the reattach re-sends just the turn
		// taken while away, not the conversation.
		expect(decision).toMatchObject({ kind: "reattach", sdkSessionId: turn.sdkSessionId, from: 1 });
		expect(awayHashes.slice(0, 1)).toEqual(turn.turnHashes);
		expect(awayHashes).toHaveLength(2);
	});
});
