import type { TUI } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	type StatusIndicator,
	WorkingStatusIndicator,
} from "../../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { appendStartupHeader } from "../../src/modes/interactive/tips/startup-header.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const TIP_BODY = "Tip: Press ctrl+p to rotate favorites.";
const TIP_POINTER = "↳ Want the full story on any tip? Ask about it.";
const TIP_LINE = `${TIP_BODY}\n${TIP_POINTER}`;

type StatusEditor = {
	embedWorkingStatus: boolean;
	setWorkingStatusIndicator: (indicator: StatusIndicator | undefined) => void;
};

type ShowStatusContext = {
	workingStartedAt: number;
	activeStatusIndicator: StatusIndicator | undefined;
	activeWorkingIndicatorEmbedded: boolean;
	statusContainer: Container;
	defaultEditor: StatusEditor;
	editor: StatusEditor;
	resolveTurnWorkingTip: () => { line: string; tipId: string };
};

const showStatusIndicator = (
	InteractiveMode.prototype as unknown as {
		showStatusIndicator(this: ShowStatusContext, indicator: StatusIndicator): void;
	}
).showStatusIndicator;

function renderedLines(container: Container): string[] {
	return container.render(120).map((line) => stripAnsi(line).trim());
}

function showWorkingTip(embedWorkingStatus: boolean, indicator: StatusIndicator): Container {
	const editor: StatusEditor = { embedWorkingStatus, setWorkingStatusIndicator: vi.fn() };
	const statusContainer = new Container();
	showStatusIndicator.call(
		{
			workingStartedAt: 0,
			activeStatusIndicator: undefined,
			activeWorkingIndicatorEmbedded: false,
			statusContainer,
			defaultEditor: editor,
			editor,
			resolveTurnWorkingTip: () => ({ line: TIP_LINE, tipId: "favorites" }),
		},
		indicator,
	);
	return statusContainer;
}

describe("tip line spacing", () => {
	it("separates the startup tip from the header with exactly one blank line", () => {
		const container = new Container();
		appendStartupHeader(container, new Text("pi v2026.7.27\nctrl+c to interrupt", 1, 0), TIP_LINE);

		expect(renderedLines(container)).toEqual([
			"",
			"pi v2026.7.27",
			"ctrl+c to interrupt",
			"",
			TIP_BODY,
			TIP_POINTER,
			"",
		]);
	});

	it("adds no blank line to the startup header when there is no tip", () => {
		const container = new Container();
		appendStartupHeader(container, new Text("pi v2026.7.27", 1, 0), undefined);

		expect(renderedLines(container)).toEqual(["", "pi v2026.7.27", ""]);
	});

	it("opens the status row with a blank line when the spinner is embedded in the editor", () => {
		initTheme("dark");
		const indicator = new WorkingStatusIndicator({ requestRender: vi.fn() } as unknown as TUI, "Working");
		try {
			expect(renderedLines(showWorkingTip(true, indicator))).toEqual(["", TIP_BODY, TIP_POINTER]);
		} finally {
			indicator.dispose();
		}
	});

	it("separates the working tip from a standalone spinner row with one blank line", () => {
		initTheme("dark");
		const indicator = new WorkingStatusIndicator({ requestRender: vi.fn() } as unknown as TUI, "Working");
		try {
			const statusContainer = showWorkingTip(false, indicator);
			const wrapper = statusContainer.children[0];
			expect(wrapper).toBeInstanceOf(Container);
			expect((wrapper as Container).children[1]).toBeInstanceOf(Spacer);

			const lines = renderedLines(statusContainer);
			const tipIndex = lines.indexOf(TIP_BODY);
			expect(tipIndex).toBeGreaterThan(1);
			expect(lines[tipIndex - 1]).toBe("");
			expect(lines[tipIndex - 2]).toContain("Working");
		} finally {
			indicator.dispose();
		}
	});
});
