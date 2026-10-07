import { expect, it } from "vitest";
import { formatUserMessage, parseAskUserAnswerFrame } from "../../src/core/extensions/builtin/ask-user/format.ts";
import type { QuestionResponse } from "../../src/core/extensions/builtin/ask-user/schema.ts";
import { parseAskUserAnswerFrame as parseChipFrame } from "../../src/modes/interactive/components/ask-user-answer-chip.ts";

// #1857: recovery and display must consume the formatter's single frame grammar.
it.each<QuestionResponse["status"]>([
	"answered",
	"comment-submitted",
	"timed_out",
	"cancelled",
	"orphaned-after-restart",
	"unavailable",
])("round trips a %s answer through the shared parser", (status) => {
	expect(parseAskUserAnswerFrame).toBe(parseChipFrame);
	const requestId = "call-frame-1857";
	const response: QuestionResponse = { status, answers: { q1: { selected: ["A"] } }, unanswered: [] };
	expect(parseAskUserAnswerFrame(formatUserMessage(response, requestId))?.requestId).toBe(requestId);
});
