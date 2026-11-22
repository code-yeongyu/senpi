import { Container, Text, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { IdleStatus } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/**
 * Regression #2836 (review of #2849): a turn nobody typed (auto-retry, an extension's triggerTurn) can
 * start while the reader is still scrolled up. Its agent_start must not replay the scrollback under them.
 */
class CountingTerminal extends VirtualTerminal {
	scrollbackClears = 0;
	override write(data: string): void {
		this.scrollbackClears += data.split("\x1b[3J").length - 1;
		super.write(data);
	}
	private get emulator(): XtermLike {
		return Reflect.get(this, "xterm") as XtermLike;
	}
	scrollUp(lines: number): void {
		this.emulator.scrollLines(-lines);
	}
	topVisibleRow(): string {
		const buffer = this.emulator.buffer.active;
		return buffer.getLine(buffer.viewportY)?.translateToString(true) ?? "";
	}
}

interface XtermLike {
	scrollLines(amount: number): void;
	buffer: {
		active: { viewportY: number; getLine(row: number): { translateToString(trim: boolean): string } | undefined };
	};
}

const handleEvent = (
	InteractiveMode.prototype as unknown as { handleEvent: (event: { type: string }) => Promise<void> }
).handleEvent;

function growingTable(rows: number): string {
	const lines = ["| name | value |"];
	for (let row = 0; row < rows; row++) lines.push(`| r${"x".repeat(row)} | v${row} |`);
	const width = Math.max(...lines.map((line) => line.length));
	return lines.map((line) => line.padEnd(width, ".")).join("\n");
}

function host(ui: TUI) {
	return {
		activeStatusIndicator: undefined,
		statusContainer: new Container(),
		pendingUserInputs: [],
		workingVisible: true,
		workingMessage: undefined,
		defaultWorkingMessage: "Working",
		isInitialized: true,
		options: { tuiMode: "regular" },
		idleStatus: new IdleStatus(),
		turnWorkingTip: { resetForNewTurn: vi.fn() },
		chrome: { createWorkingIndicator: () => ({ kind: "working", dispose: vi.fn() }) },
		footer: { invalidate: vi.fn() },
		settingsManager: { getShowTerminalProgress: () => false },
		ui,
		checkShutdownRequested: vi.fn(async () => {}),
		clearPendingTools: vi.fn(),
		clearActiveToolExecutionStatus: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		streamingReveal: { stop: vi.fn() },
		toolResultReveal: { stop: vi.fn() },
		detachAssistantTextSegments: vi.fn(),
		streamingComponent: undefined,
		getWorkingIndicatorOptions: () => ({}),
		showStatusIndicator: vi.fn(),
		clearStatusIndicator: vi.fn(),
	};
}

describe("a turn nobody typed starts while the reader is scrolled up (#2836)", () => {
	it("does not replay the scrollback or move the reader's view", async () => {
		const terminal = new CountingTerminal(60, 12);
		const ui = new TUI(terminal, { muxDetector: () => false });
		const chat = new Container();
		for (let index = 0; index < 6; index++) chat.addChild(new Text(`earlier ${index}`, 0, 0));
		const live = new Text("", 0, 0);
		chat.addChild(live);
		ui.addChild(chat);
		ui.addChild(new Text("> editor", 0, 0));
		ui.start();
		ui.renderNow();
		const mode = host(ui);

		// a first turn streams a widening table, leaving rows above the viewport stale
		await handleEvent.call(mode, { type: "agent_start" });
		for (let rows = 1; rows <= 30; rows++) {
			live.setText(growingTable(rows));
			ui.renderNow();
		}
		await handleEvent.call(mode, { type: "agent_end" });
		ui.renderNow();
		await terminal.flush();
		terminal.scrollUp(6);
		const watching = terminal.topVisibleRow();
		const clearsBefore = terminal.scrollbackClears;

		// an auto-retry or extension turn starts with no key press
		await handleEvent.call(mode, { type: "agent_start" });
		ui.renderNow();
		await terminal.flush();

		expect(terminal.scrollbackClears).toBe(clearsBefore);
		expect(terminal.topVisibleRow()).toBe(watching);
		ui.stop();
	});
});
