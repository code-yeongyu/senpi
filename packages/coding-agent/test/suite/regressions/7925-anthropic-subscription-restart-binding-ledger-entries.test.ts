/**
 * oh-my-openagent#7925: the persisted restart binding was discarded whenever a
 * co-resident extension appended a `custom` ledger entry after the committed
 * assistant (omo memory writes several per turn and one on every session_start),
 * so `omo --session <id>` cold-seeded with `registry_miss` and re-sent the whole
 * conversation. Ledger entries never enter the LLM context, so they cannot shift
 * the sent-stream digest the binding is verified against. Entries that rewrite
 * the anchored assistant's meaning (compaction, branch summaries) must keep
 * failing closed. senpi#1964 realigned the append-only tail: a later user message
 * or custom message extends the branch without rewriting its anchor, and
 * decideNativeContinuity proves the resume safe through sentPrefixHash, so those
 * now keep the binding instead of forcing a full re-send.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readStoredBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-binding-store.ts";
import {
	bindingFromEntry,
	forgetBinding,
	getBinding,
	rememberBinding,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { registerSessionRegistry } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry-wiring.ts";
import { recordSyncedStream } from "../../../src/core/extensions/builtin/anthropic-subscription/session-sync.ts";
import {
	assistant,
	type BranchEntry,
	cleanupRestartFixture,
	context,
	emit,
	fakeExtension,
	residentEntry,
	SESSION_ID,
	sessionFixture,
} from "../../helpers/anthropic-subscription-restart-fixture.ts";

afterEach(() => {
	cleanupRestartFixture();
});

async function persistTurnAndRestart(suffix: BranchEntry[], between: BranchEntry[] = []) {
	const { sessionFile, branch, turnHashes } = sessionFixture();
	const extension = fakeExtension(branch);
	registerSessionRegistry(extension.api);
	const entry = residentEntry();
	rememberBinding(bindingFromEntry(entry, turnHashes));
	const eventContext = context(sessionFile, branch);
	recordSyncedStream(entry, turnHashes);

	await emit(extension.handlers, "message_end", { type: "message_end", message: assistant() }, eventContext);
	branch.push(...between);
	branch.push({ type: "message", id: "assistant-entry", message: assistant() });
	branch.push(...suffix);
	expect(await readStoredBinding(sessionFile)).toMatchObject({ sessionId: SESSION_ID, sentCount: 1 });

	closeSession(SESSION_ID, "process_exit");
	forgetBinding(SESSION_ID);
	const restarted = fakeExtension(branch);
	registerSessionRegistry(restarted.api);
	await emit(restarted.handlers, "session_start", { type: "session_start", reason: "resume" }, eventContext);
	return { sessionFile, sdkSessionId: entry.sdkSessionId };
}

describe("oh-my-openagent#7925 restart binding survives ledger entries", () => {
	it("restores the binding across arbitrary custom ledger entries appended after the assistant", async () => {
		const { sessionFile, sdkSessionId } = await persistTurnAndRestart([
			{ type: "custom", id: "memory-accepted", customType: "omo.memory.accepted-turns", data: { turns: 3 } },
			{ type: "custom", id: "memory-nudged", customType: "omo.memory.nudged", data: { nudges: [] } },
			{ type: "custom", id: "memory-binding", customType: "omo.memory.binding", data: { identity: "x" } },
			{ type: "label", id: "label-1", label: "checkpoint" } as unknown as BranchEntry,
			{ type: "thinking_level_change", id: "thinking-1", thinkingLevel: "high" } as unknown as BranchEntry,
			{ type: "session_info", id: "info-1", name: "renamed" } as unknown as BranchEntry,
		]);

		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId, sentCount: 1 });
		expect(await readStoredBinding(sessionFile)).toMatchObject({ sessionId: SESSION_ID });
	});

	it("restores the binding when a later message_end handler appended a ledger entry before the assistant", async () => {
		const { sdkSessionId } = await persistTurnAndRestart(
			[],
			[{ type: "custom", id: "late-handler", customType: "omo.fallback-architect.note", data: {} }],
		);

		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId, sentCount: 1 });
	});

	// senpi#1964: realigned from "still fails closed". A later user message is an unsent delta
	// whose safety decideNativeContinuity proves by comparing sentPrefixHash before resuming;
	// a custom message is never transmitted on this lane (isTransmittedMessage admits only user
	// and toolResult), so neither can make a resume diverge. Rejecting them here re-sent whole
	// conversations as registry_miss.
	const appendOnlyEntries: Array<[string, BranchEntry]> = [
		["a user message", { type: "message", id: "user-2", message: { role: "user", content: "again", timestamp: 2 } }],
		[
			"a custom message",
			{ type: "custom_message", id: "nudge", customType: "ttsr-injection", content: "nudge", display: false },
		],
	];

	it.each(appendOnlyEntries)("keeps the binding when %s follows the assistant (#1964)", async (_label, entry) => {
		const { sessionFile, sdkSessionId } = await persistTurnAndRestart([entry]);

		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId, sentCount: 1 });
		expect(await readStoredBinding(sessionFile)).toMatchObject({ sessionId: SESSION_ID });
	});

	const modelVisibleEntries: Array<[string, BranchEntry]> = [
		[
			"a compaction entry",
			{
				type: "compaction",
				id: "compaction-1",
				summary: "summary",
				firstKeptEntryId: "user-entry",
				tokensBefore: 1,
			},
		],
		[
			"a branch summary",
			{ type: "branch_summary", id: "branch-1", summary: "summary", fromId: "user-entry" } as unknown as BranchEntry,
		],
	];

	it.each(modelVisibleEntries)(
		"still fails closed when %s reaches the model after the assistant",
		async (_label, entry) => {
			const { sessionFile } = await persistTurnAndRestart([entry]);

			expect(getBinding(SESSION_ID)).toBeUndefined();
			expect(await readStoredBinding(sessionFile)).toBeUndefined();
		},
	);
});
