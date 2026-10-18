import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import {
	buildFocusRequest,
	KEY,
	mountFocus,
	OWN_ANSWER_EDITOR,
	openOwnAnswer,
} from "./ask-user-question-focus-support.ts";

describe("ask-user overlay own-answer editor focus", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("returns to the option list of the next question after committing an own answer", () => {
		const h = mountFocus();
		openOwnAnswer(h);

		h.keys("vault token", KEY.enter);

		const output = h.render();
		expect(output).toContain("Which extras should be enabled?");
		expect(output).not.toContain(OWN_ANSWER_EDITOR);
		expect(output).toContain("→ 1. Verbose logging");

		h.keys("2");
		expect(h.lastDraft()?.answers?.extras).toEqual({ selected: ["Dry run"] });
		expect(h.lastDraft()?.answers?.auth).toEqual({ selected: [], text: "vault token" });
	});

	it("Up saves the draft, closes the editor and highlights the row above", () => {
		const h = mountFocus();
		openOwnAnswer(h);

		h.keys("draft", KEY.up);

		const output = h.render();
		expect(output).not.toContain(OWN_ANSWER_EDITOR);
		expect(output).toContain("→ 2. API key");
		expect(output).toContain("Type your own answer...: draft");
		expect(h.lastDraft()?.answers?.auth).toEqual({ selected: [], text: "draft" });
	});

	it("Down saves the draft, closes the editor and keeps the own-answer row highlighted", () => {
		const h = mountFocus();
		openOwnAnswer(h);

		h.keys("d", KEY.down);

		const output = h.render();
		expect(output).not.toContain(OWN_ANSWER_EDITOR);
		expect(output).toContain("→ Type your own answer...: d");
	});

	it("Tab saves and switches to the next question; Shift+Tab comes back to the options", () => {
		const h = mountFocus();
		openOwnAnswer(h);

		h.keys("x", KEY.tab);
		expect(h.render()).toContain("Which extras should be enabled?");
		expect(h.render()).not.toContain(OWN_ANSWER_EDITOR);
		expect(h.lastDraft()?.answers?.auth).toEqual({ selected: [], text: "x" });

		h.keys(KEY.shiftTab);
		expect(h.render()).toContain("Which auth method should the CLI use?");
		expect(h.render()).toContain("→ 1. OAuth");
	});

	it("leaving an empty editor with Up keeps the question's existing selection", () => {
		const h = mountFocus();

		h.keys(KEY.tab, KEY.space, KEY.down, KEY.down, KEY.enter);
		expect(h.render()).toContain(OWN_ANSWER_EDITOR);

		h.keys(KEY.up);

		expect(h.render()).not.toContain(OWN_ANSWER_EDITOR);
		expect(h.lastDraft()?.answers?.extras).toEqual({ selected: ["Verbose logging"] });
		expect(h.render()).toContain("Submit (1/2 answered)");
	});

	it("Backspace on an empty editor returns to the option list", () => {
		const h = mountFocus();
		openOwnAnswer(h);

		h.keys(KEY.backspace);

		const output = h.render();
		expect(output).not.toContain(OWN_ANSWER_EDITOR);
		expect(output).toContain("→ Type your own answer...");
		expect(h.doneCalls).toHaveLength(0);
	});

	it("Left and Right move the cursor inside the editor instead of switching tabs", () => {
		const h = mountFocus();
		openOwnAnswer(h);

		h.keys("ac", KEY.left, "b", KEY.right, "d", KEY.enter);

		expect(h.lastDraft()?.answers?.auth).toEqual({ selected: [], text: "abcd" });
		expect(h.render()).toContain("Which extras should be enabled?");
	});

	it("Esc in async mode discards the draft and returns to the options without collapsing", () => {
		const h = mountFocus(buildFocusRequest(false));
		openOwnAnswer(h);

		h.keys("z", KEY.esc);

		expect(h.doneCalls).toHaveLength(0);
		const output = h.render();
		expect(output).not.toContain(OWN_ANSWER_EDITOR);
		expect(output).toContain("→ Type your own answer...");
		expect(output).not.toContain("Type your own answer...: z");
	});
});
