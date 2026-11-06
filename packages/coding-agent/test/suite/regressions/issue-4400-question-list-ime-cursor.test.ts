import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { type FocusHarness, KEY, mountFocus, openOwnAnswer, reachSubmit } from "../ask-user-question-focus-support.ts";

const OWN_ANSWER_ROW = "Type your own answer...";

function markerLines(h: FocusHarness): string[] {
	return h.component.render(100).filter((line) => line.includes(CURSOR_MARKER));
}

function textBeforeMarker(line: string): string {
	return stripAnsi(line.slice(0, line.indexOf(CURSOR_MARKER)));
}

describe("issue #4400: IME composition while the question list has focus", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("places the cursor at the end of the own-answer row, where typed text goes", () => {
		const h = mountFocus();
		h.component.focused = true;

		const lines = markerLines(h);

		expect(lines).toHaveLength(1);
		expect(textBeforeMarker(lines[0] ?? "").trimStart()).toBe(OWN_ANSWER_ROW);
	});

	it("keeps the cursor on the own-answer row whichever option is highlighted", () => {
		const h = mountFocus();
		h.component.focused = true;
		h.keys(KEY.down);

		expect(
			markerLines(h)
				.map(textBeforeMarker)
				.map((text) => text.trimStart()),
		).toEqual([OWN_ANSWER_ROW]);
	});

	it("follows an existing own answer on that row", () => {
		const h = mountFocus();
		h.component.focused = true;
		openOwnAnswer(h);
		h.keys("draft", KEY.up);

		expect(
			markerLines(h)
				.map(textBeforeMarker)
				.map((text) => text.trimStart()),
		).toEqual([`${OWN_ANSWER_ROW}: draft`]);
	});

	it("emits no cursor while the overlay is not focused", () => {
		const h = mountFocus();

		expect(markerLines(h)).toEqual([]);
	});

	it("leaves the cursor to the open own-answer editor and the comment editor", () => {
		const own = mountFocus();
		own.component.focused = true;
		openOwnAnswer(own);
		own.keys("ab");
		expect(markerLines(own).map((line) => textBeforeMarker(line).trim())).toEqual(["> ab"]);

		const submit = mountFocus();
		submit.component.focused = true;
		reachSubmit(submit);
		expect(markerLines(submit)).toHaveLength(1);
		expect(markerLines(submit)[0]).not.toContain(OWN_ANSWER_ROW);
	});
});
