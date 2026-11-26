import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../../src/core/compaction/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#3864: retaining invisible bookkeeping must not pull an earlier conversation turn into the kept tail.
it.each(["session-lifecycle", "extension-note"])(
	"keeps a whole-turn boundary when %s precedes its user message",
	(customType) => {
		// Given a completed turn followed by bookkeeping and an unanswered prompt.
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "Earlier question", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Earlier answer"));
		const bookkeepingId = manager.appendCustomEntry(customType, { seq: 1 });
		manager.appendMessage({ role: "user", content: "Next question", timestamp: 2 });

		// When compaction keeps only the latest prompt.
		const preparation = prepareCompaction(manager.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
		});

		// Then bookkeeping remains with that prompt without making it a split of the earlier turn.
		expect(preparation).toMatchObject({
			firstKeptEntryId: bookkeepingId,
			isSplitTurn: false,
			messagesToSummarize: [
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({ role: "assistant" }),
			],
			turnPrefixMessages: [],
		});
	},
);

it("advances past the first message cut when lifecycle bookkeeping precedes it", () => {
	// Given an overflowing first turn whose failed answer must be retried.
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("session-lifecycle", { seq: 1 });
	manager.appendMessage({ role: "user", content: "Question".repeat(100), timestamp: 1 });
	const failureId = manager.appendMessage(
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
	);

	// When recovery forces progress beyond the first semantic cut point.
	const preparation = prepareCompaction(
		manager.getBranch(),
		{ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 },
		true,
	);

	// Then the original prompt is summarized instead of choosing that same prompt again.
	expect(preparation).toMatchObject({
		firstKeptEntryId: failureId,
		isSplitTurn: true,
		turnPrefixMessages: [expect.objectContaining({ role: "user" })],
	});
});
