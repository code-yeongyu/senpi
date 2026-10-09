import { describe, expect, it } from "vitest";
import { AskUserQuestionState } from "../../src/modes/interactive/components/ask-user-question-state.ts";
import { buildFocusRequest } from "./ask-user-question-focus-support.ts";

describe("ask-user question navigation", () => {
	it.each([
		[-1, "Auth"],
		[Number.NaN, "Auth"],
		[1.5, "Extras"],
		[99, "Extras"],
	])("clamps question index %i to %s", (index, header) => {
		const state = new AskUserQuestionState(buildFocusRequest());

		state.jumpToQuestion(index);

		expect(state.activeQuestion.header).toBe(header);
	});
});
