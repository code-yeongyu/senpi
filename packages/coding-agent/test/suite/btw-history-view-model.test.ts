import { describe, expect, it } from "vitest";
import {
	type BtwHistoryViewEntry,
	BtwHistoryViewModel,
} from "../../src/core/extensions/builtin/btw/history-view-model.ts";

describe("BtwHistoryViewModel", () => {
	const entries: readonly BtwHistoryViewEntry[] = [
		{ question: "first question", answer: "first answer" },
		{ question: "second question", answer: "second answer" },
		{ question: "third question", answer: "third answer" },
	];

	it("reports empty state and ignores every mutation when entries are empty", () => {
		// given
		const viewModel = new BtwHistoryViewModel([]);

		// when
		const previousChanged = viewModel.selectPrevious();
		const nextChanged = viewModel.selectNext();
		const upChanged = viewModel.scrollUp();
		const downChanged = viewModel.scrollDown();
		viewModel.setAnswerLineCount(10);
		viewModel.setViewportHeight(4);

		// then
		expect(viewModel.entryCount).toBe(0);
		expect(viewModel.selectedIndex).toBe(0);
		expect(viewModel.selected).toBeUndefined();
		expect(viewModel.scrollOffset).toBe(0);
		expect(viewModel.maxScrollOffset).toBe(0);
		expect(previousChanged).toBe(false);
		expect(nextChanged).toBe(false);
		expect(upChanged).toBe(false);
		expect(downChanged).toBe(false);
	});

	it("selects the first entry by default", () => {
		// given
		const viewModel = new BtwHistoryViewModel(entries);

		// then
		expect(viewModel.entryCount).toBe(3);
		expect(viewModel.selectedIndex).toBe(0);
		expect(viewModel.selected).toEqual(entries[0]);
	});

	it("moves selection without wrapping around the history bounds", () => {
		// given
		const viewModel = new BtwHistoryViewModel(entries);

		// when
		const previousAtStart = viewModel.selectPrevious();
		const movedToSecond = viewModel.selectNext();
		const movedToThird = viewModel.selectNext();
		const nextAtEnd = viewModel.selectNext();

		// then
		expect(previousAtStart).toBe(false);
		expect(movedToSecond).toBe(true);
		expect(movedToThird).toBe(true);
		expect(nextAtEnd).toBe(false);
		expect(viewModel.selectedIndex).toBe(2);
		expect(viewModel.selected).toEqual(entries[2]);
	});

	it("resets scroll offset after a successful selection change", () => {
		// given
		const viewModel = new BtwHistoryViewModel(entries);
		viewModel.setAnswerLineCount(5);
		viewModel.setViewportHeight(3);
		viewModel.scrollDown();
		viewModel.scrollDown();

		// when
		const movedNext = viewModel.selectNext();
		const offsetAfterMovedNext = viewModel.scrollOffset;
		viewModel.setAnswerLineCount(5);
		viewModel.setViewportHeight(3);
		viewModel.scrollDown();
		const offsetBeforeMovedPrevious = viewModel.scrollOffset;
		const movedPrevious = viewModel.selectPrevious();

		// then
		expect(movedNext).toBe(true);
		expect(offsetAfterMovedNext).toBe(0);
		expect(offsetBeforeMovedPrevious).toBe(1);
		expect(movedPrevious).toBe(true);
		expect(viewModel.selectedIndex).toBe(0);
		expect(viewModel.scrollOffset).toBe(0);
	});

	it("calculates max scroll offset from answer line count and viewport height", () => {
		// given
		const viewModel = new BtwHistoryViewModel(entries);

		// when
		viewModel.setAnswerLineCount(8);
		viewModel.setViewportHeight(3);

		// then
		expect(viewModel.maxScrollOffset).toBe(5);
	});

	it("scrolls by one line and stops at top and bottom boundaries", () => {
		// given
		const viewModel = new BtwHistoryViewModel(entries);
		viewModel.setAnswerLineCount(4);
		viewModel.setViewportHeight(2);

		// when
		const upAtTop = viewModel.scrollUp();
		const firstDown = viewModel.scrollDown();
		const secondDown = viewModel.scrollDown();
		const downAtBottom = viewModel.scrollDown();
		const firstUp = viewModel.scrollUp();

		// then
		expect(upAtTop).toBe(false);
		expect(firstDown).toBe(true);
		expect(secondDown).toBe(true);
		expect(downAtBottom).toBe(false);
		expect(firstUp).toBe(true);
		expect(viewModel.scrollOffset).toBe(1);
	});

	it("does not scroll down when the selected answer fits the viewport", () => {
		// given
		const viewModel = new BtwHistoryViewModel(entries);

		// when
		viewModel.setAnswerLineCount(3);
		viewModel.setViewportHeight(3);
		const changed = viewModel.scrollDown();

		// then
		expect(viewModel.maxScrollOffset).toBe(0);
		expect(viewModel.scrollOffset).toBe(0);
		expect(changed).toBe(false);
	});

	it("clamps scroll offset when answer line count or viewport height changes", () => {
		// given
		const viewModel = new BtwHistoryViewModel(entries);
		viewModel.setAnswerLineCount(10);
		viewModel.setViewportHeight(3);
		for (let step = 0; step < 7; step += 1) {
			viewModel.scrollDown();
		}

		// when
		viewModel.setAnswerLineCount(5);
		const offsetAfterLineCountShrink = viewModel.scrollOffset;
		viewModel.setAnswerLineCount(10);
		for (let step = 0; step < 5; step += 1) {
			viewModel.scrollDown();
		}
		const offsetBeforeViewportGrow = viewModel.scrollOffset;
		viewModel.setViewportHeight(8);

		// then
		expect(offsetAfterLineCountShrink).toBe(2);
		expect(offsetBeforeViewportGrow).toBe(7);
		expect(viewModel.maxScrollOffset).toBe(2);
		expect(viewModel.scrollOffset).toBe(2);
	});
});
