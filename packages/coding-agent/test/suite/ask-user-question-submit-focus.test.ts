import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import {
	buildFocusRequest,
	KEY,
	mountFocus,
	OWN_ANSWER_EDITOR,
	reachSubmit,
} from "./ask-user-question-focus-support.ts";

describe("ask-user overlay Submit tab and option-list focus", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("Up from the comment editor highlights the last review row", () => {
		const h = mountFocus();
		reachSubmit(h);

		h.keys(KEY.up);

		expect(h.render()).toContain("→ Extras: Verbose logging");
		expect(h.render()).not.toContain("→ Auth: OAuth");
	});

	it("Enter on a highlighted review row jumps to that question", () => {
		const h = mountFocus();
		reachSubmit(h);

		h.keys(KEY.up, KEY.up, KEY.enter);

		const output = h.render();
		expect(output).toContain("Which auth method should the CLI use?");
		expect(output).toContain("→ 1. OAuth ✓");
		expect(h.doneCalls).toHaveLength(0);
	});

	it("Down past the last review row returns to the comment editor where Enter submits", () => {
		const h = mountFocus();
		reachSubmit(h);

		h.keys(KEY.up, KEY.down, KEY.enter);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]).toMatchObject({ status: "answered", unanswered: [] });
	});

	it("typing on a review row goes into the comment editor", () => {
		const h = mountFocus();
		reachSubmit(h);

		h.keys(KEY.up, "n", "ote", KEY.enter);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]).toMatchObject({ status: "comment-submitted", comment: "note" });
	});

	it("Left and Right move the cursor in a non-empty comment and switch tabs when it is empty", () => {
		const h = mountFocus();
		reachSubmit(h);

		h.keys("ac", KEY.left, "b", KEY.right, "d");
		expect(h.render()).toContain("Review your answers");
		expect(h.render()).toContain("abcd");

		const empty = mountFocus();
		reachSubmit(empty);
		empty.keys(KEY.left);
		expect(empty.render()).toContain("Which extras should be enabled?");
	});

	it("Esc in async mode collapses the overlay so the composer comment can finish the draft", () => {
		const h = mountFocus(buildFocusRequest(false));
		reachSubmit(h);

		h.keys(KEY.esc);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]).toMatchObject({
			status: "cancelled",
			answers: { auth: { selected: ["OAuth"] }, extras: { selected: ["Verbose logging"] } },
		});
	});

	it("Backspace on the option list clears the active answer and never opens the own-answer editor", () => {
		const h = mountFocus();

		h.keys(KEY.backspace);
		expect(h.render()).not.toContain(OWN_ANSWER_EDITOR);

		h.keys("1", KEY.shiftTab);
		expect(h.lastDraft()?.answers?.auth).toEqual({ selected: ["OAuth"] });

		h.keys(KEY.backspace);
		expect(h.lastDraft()?.answers?.auth).toBeUndefined();
		expect(h.render()).not.toContain(OWN_ANSWER_EDITOR);
		expect(h.render()).toContain("Submit (0/2 answered)");
	});

	it("restores selections, own texts and the comment passed at mount", () => {
		const h = mountFocus(buildFocusRequest(false), {
			initialDraft: {
				answers: { auth: { selected: ["OAuth"] }, extras: { selected: [], text: "custom" } },
				comment: "hello",
			},
		});

		expect(h.render()).toContain("Submit (2/2 answered)");
		expect(h.render()).toContain("→ 1. OAuth ✓");

		h.keys(KEY.tab, KEY.tab);
		const output = h.render();
		expect(output).toContain("Auth: OAuth");
		expect(output).toContain("Extras: custom");
		expect(output).toContain("hello");

		h.keys(KEY.enter);
		expect(h.doneCalls[0]).toMatchObject({
			status: "comment-submitted",
			comment: "hello",
			answers: { auth: { selected: ["OAuth"] }, extras: { selected: [], text: "custom" } },
			unanswered: [],
		});
	});
});
