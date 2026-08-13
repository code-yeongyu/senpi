import { describe, expect, it } from "vitest";
import { BtwHistoryViewModel } from "../../src/core/extensions/builtin/btw/history-view-model.ts";

const entries = [
	{ question: "first question", answer: "first answer" },
	{ question: "second question", answer: "second answer" },
	{ question: "third question", answer: "third answer" },
] as const;

describe("BtwHistoryViewModel", () => {
	it("moves selection within bounds without wrapping", () => {
		const model = new BtwHistoryViewModel(entries);

		expect(model.selectPrevious()).toBe(false);
		expect(model.selectNext()).toBe(true);
		expect(model.selectNext()).toBe(true);
		expect(model.selectNext()).toBe(false);
		expect(model.selected).toEqual(entries[2]);
	});

	it("resets answer scroll after changing the selected question", () => {
		const model = new BtwHistoryViewModel(entries);
		model.setAnswerLineCount(5);
		model.setViewportHeight(3);
		model.scrollDown();

		expect(model.selectNext()).toBe(true);
		expect(model.scrollOffset).toBe(0);
	});

	it("clamps scrolling to the current answer viewport", () => {
		const model = new BtwHistoryViewModel(entries);
		model.setAnswerLineCount(5);
		model.setViewportHeight(3);

		expect(model.scrollUp()).toBe(false);
		expect(model.scrollDown()).toBe(true);
		expect(model.scrollDown()).toBe(true);
		expect(model.scrollDown()).toBe(false);
		model.setViewportHeight(4);
		expect(model.scrollOffset).toBe(1);
	});
});
