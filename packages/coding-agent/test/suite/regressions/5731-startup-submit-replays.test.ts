import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// senpi#5731: a submit made while the TUI is still starting is parked in the editor behind
// "Startup is still in progress". Nothing ran it once startup finished, so an early /resume sat
// typed in the editor until the person pressed Enter a second time.

vi.mock("../../../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

type StartupContext = {
	startupParkedSubmission?: string;
	editor: { text: string; setText: (text: string) => void; getText: () => string };
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	showStatus: (message: string) => void;
	shutdown: () => Promise<void>;
};

type StartupMethods = {
	handleStartupSubmit(this: StartupContext, text: string): void;
	replayStartupSubmission(this: StartupContext): void;
};

const prototype = InteractiveMode.prototype as unknown as StartupMethods;

function startingTui(): StartupContext & { submitted: string[] } {
	const submitted: string[] = [];
	const editor = {
		text: "",
		setText(text: string) {
			editor.text = text;
		},
		getText: () => editor.text,
	};
	return {
		submitted,
		editor,
		defaultEditor: {},
		showStatus: vi.fn(),
		shutdown: vi.fn(async () => {}),
	};
}

function finishStartup(tui: ReturnType<typeof startingTui>): void {
	tui.defaultEditor.onSubmit = (text) => {
		tui.submitted.push(text);
	};
	prototype.replayStartupSubmission.call(tui);
}

describe("a submit made during startup runs once startup finishes (#5731)", () => {
	it("submits a parked /resume exactly once through the real submit handler", () => {
		const tui = startingTui();
		prototype.handleStartupSubmit.call(tui, "/resume");
		expect(tui.editor.getText()).toBe("/resume");
		expect(tui.showStatus).toHaveBeenCalledWith("Startup is still in progress");

		finishStartup(tui);

		expect(tui.submitted).toEqual(["/resume"]);
		expect(tui.editor.getText()).toBe("");
		prototype.replayStartupSubmission.call(tui);
		expect(tui.submitted).toEqual(["/resume"]);
	});

	it("leaves a parked draft the person edited before startup finished", () => {
		const tui = startingTui();
		prototype.handleStartupSubmit.call(tui, "/resume");
		tui.editor.setText("/resume and more");

		finishStartup(tui);

		expect(tui.submitted).toEqual([]);
		expect(tui.editor.getText()).toBe("/resume and more");
	});

	it("submits nothing when nothing was submitted during startup", () => {
		const tui = startingTui();
		tui.editor.setText("typed but never sent");

		finishStartup(tui);

		expect(tui.submitted).toEqual([]);
		expect(tui.editor.getText()).toBe("typed but never sent");
	});
});
