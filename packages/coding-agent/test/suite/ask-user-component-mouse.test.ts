import { setKeybindings, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, expect, it, vi } from "vitest";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const request: QuestionRequest = {
	requestId: "mouse-component",
	waitForAnswer: false,
	timeoutMs: 0,
	questions: [
		{
			id: "auth",
			header: "Auth",
			question: "Choose authentication",
			options: [
				{ label: "OAuth", description: "SSO description" },
				{ label: "API key", description: "Static credential" },
			],
			multiSelect: false,
		},
		{
			id: "extras",
			header: "Extras",
			question: "Choose extras",
			options: [{ label: "Docs" }, { label: "Tests" }],
			multiSelect: true,
		},
	],
};
beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
function setup() {
	const done = vi.fn();
	const progress = vi.fn();
	const component = new AskUserQuestionComponent(request, done, { onProgress: progress });
	const render = () => component.render(100).map(stripAnsi);
	const event = (type: TuiMouseEvent["type"], label: string): TuiMouseEvent => {
		const lines = render();
		const y = lines.findIndex((line) => line.includes(label));
		expect(y).toBeGreaterThanOrEqual(0);
		const x = lines[y].indexOf(label);
		return {
			type,
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 100,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
	};
	const click = (label: string) => {
		const press = event("press", label);
		expect(component.handleMouse(press)).toMatchObject({ handled: true, focus: true });
		component.handleMouse({ ...press, type: "click" });
	};
	return { component, done, progress, render, event, click };
}
it("claims tab presses without activation, then changes tabs on click (#1645)", () => {
	const h = setup();
	try {
		const press = h.event("press", "Extras");
		expect(h.component.handleMouse(press)).toMatchObject({ handled: true, focus: true });
		expect(h.render().join("\n")).toContain("Choose authentication");
		h.component.handleMouse({ ...press, type: "click" });
		expect(h.render().join("\n")).toContain("Choose extras");
	} finally {
		h.component.dispose();
	}
});
it("selects option two after a description row and advances the single-select question", () => {
	const h = setup();
	try {
		h.click("2. API key");
		expect(h.progress).toHaveBeenLastCalledWith({ answers: { auth: { selected: ["API key"] } } });
		expect(h.render().join("\n")).toContain("Choose extras");
		expect(h.done).not.toHaveBeenCalled();
	} finally {
		h.component.dispose();
	}
});
it("multi-select clicks toggle without advancing", () => {
	const h = setup();
	try {
		h.click("Extras");
		h.click("1. Docs");
		expect(h.progress).toHaveBeenLastCalledWith({ answers: { extras: { selected: ["Docs"] } } });
		expect(h.render().join("\n")).toContain("Choose extras");
		h.click("1. Docs");
		expect(h.progress).toHaveBeenLastCalledWith({ answers: {} });
	} finally {
		h.component.dispose();
	}
});
it("opens own-answer input and forwards mouse caret placement", () => {
	const h = setup();
	try {
		h.click("Type your own answer...");
		expect(h.render().join("\n")).toContain("Your answer (enter to save");
		h.component.handleInput("custom");
		h.click("custom");
		h.component.handleInput("X");
		expect(h.render().join("\n")).toContain("Xcustom");
	} finally {
		h.component.dispose();
	}
});
it("enters Submit on the first click and submits on the second", () => {
	const h = setup();
	try {
		h.click("1. OAuth");
		h.click("1. Docs");
		h.click("Submit");
		expect(h.done).not.toHaveBeenCalled();
		expect(h.render().join("\n")).toContain("Review your answers");
		h.click("Submit");
		expect(h.done).toHaveBeenCalledOnce();
		expect(h.done.mock.calls[0][0]).toMatchObject({
			status: "answered",
			answers: { auth: { selected: ["OAuth"] }, extras: { selected: ["Docs"] } },
		});
	} finally {
		h.component.dispose();
	}
});
it("ignores descriptions, right clicks, double clicks and press-only selection", () => {
	const h = setup();
	try {
		const description = h.event("press", "SSO description");
		expect(h.component.handleMouse(description)).toBeUndefined();
		const press = h.event("press", "2. API key");
		h.component.handleMouse(press);
		h.component.handleMouse({ ...press, type: "click", clickCount: 2 });
		h.component.handleMouse({ ...press, button: "right" });
		expect(h.progress).not.toHaveBeenCalled();
		expect(h.render().join("\n")).toContain("Choose authentication");
	} finally {
		h.component.dispose();
	}
});
it("clickable rows keep the question as the keyboard owner instead of claiming focus (#1882)", () => {
	const h = setup();
	try {
		for (const label of ["1. OAuth", "Extras", "Submit"]) {
			const result = h.component.handleMouse(h.event("press", label));
			// The clicked row cannot receive keys, so the question component must stay the
			// keyboard owner; parking focus on the row kills typing after the click.
			expect(result).toMatchObject({ handled: true, focus: true });
			expect((result as { focusTarget?: unknown }).focusTarget).toBe(h.component);
		}
	} finally {
		h.component.dispose();
	}
});
