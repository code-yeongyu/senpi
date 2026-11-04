import { describe, expect, it, vi } from "vitest";
import { InteractiveMode, replayStartupSubmission } from "../../../src/modes/interactive/interactive-mode.ts";

// senpi#5731: a submit made while the TUI is still starting is parked in the editor behind
// "Startup is still in progress". Nothing ran it once startup finished, so an early /resume sat
// typed in the editor until the person pressed Enter a second time.

vi.mock("../../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

type Editor = { text: string; setText: (text: string) => void; getText: () => string };

type Parked = { readonly text: string; readonly details?: { readonly rawText: string } };

type StartupContext = {
	startupParkedSubmission?: Parked;
	editor: Editor;
	showStatus: (message: string) => void;
	shutdown: () => Promise<void>;
};

const handleStartupSubmit = (
	InteractiveMode.prototype as unknown as {
		handleStartupSubmit(this: StartupContext, text: string, details?: { rawText: string }): void;
	}
).handleStartupSubmit;

function startingTui(): StartupContext {
	const editor: Editor = {
		text: "",
		setText(text: string) {
			editor.text = text;
		},
		getText: () => editor.text,
	};
	return { editor, showStatus: vi.fn(), shutdown: vi.fn(async () => {}) };
}

function finishStartup(tui: StartupContext, seen: unknown[] = []): string[] {
	const submitted: string[] = [];
	const parked = tui.startupParkedSubmission;
	tui.startupParkedSubmission = undefined;
	replayStartupSubmission(parked, tui.editor, {
		onSubmit: (text, details) => {
			submitted.push(text);
			seen.push(details);
		},
	});
	return submitted;
}

describe("a submit made during startup runs once startup finishes (#5731)", () => {
	it("submits a parked /resume exactly once through the real submit handler", () => {
		const tui = startingTui();
		handleStartupSubmit.call(tui, "/resume");
		expect(tui.editor.getText()).toBe("/resume");
		expect(tui.showStatus).toHaveBeenCalledWith("Startup is still in progress");

		expect(finishStartup(tui)).toEqual(["/resume"]);
		expect(tui.editor.getText()).toBe("");
		expect(finishStartup(tui)).toEqual([]);
	});

	it("leaves a parked draft the person edited before startup finished", () => {
		const tui = startingTui();
		handleStartupSubmit.call(tui, "/resume");
		tui.editor.setText("/resume and more");

		expect(finishStartup(tui)).toEqual([]);
		expect(tui.editor.getText()).toBe("/resume and more");
	});

	it("keeps the raw text of a parked submit, so a leading-space command stays text", () => {
		const tui = startingTui();
		handleStartupSubmit.call(tui, "/foo", { rawText: " /foo" });
		const seen: unknown[] = [];

		expect(finishStartup(tui, seen)).toEqual(["/foo"]);
		expect(seen).toEqual([{ rawText: " /foo" }]);
	});

	it("submits nothing when nothing was submitted during startup", () => {
		const tui = startingTui();
		tui.editor.setText("typed but never sent");

		expect(finishStartup(tui)).toEqual([]);
		expect(tui.editor.getText()).toBe("typed but never sent");
	});
});
