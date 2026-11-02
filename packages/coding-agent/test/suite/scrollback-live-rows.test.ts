import {
	type Component,
	Container,
	resetMainScreenHistoryLines,
	type Terminal,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";

const SCROLLBACK_RESET = "\x1b[3J";

// The early live rows must stay inside the kept history window, whatever the environment sets.
let previousHistoryLines: string | undefined;
beforeEach(() => {
	previousHistoryLines = process.env.PI_TUI_HISTORY_LINES;
	process.env.PI_TUI_HISTORY_LINES = "2000";
	resetMainScreenHistoryLines();
});
afterEach(() => {
	if (previousHistoryLines === undefined) delete process.env.PI_TUI_HISTORY_LINES;
	else process.env.PI_TUI_HISTORY_LINES = previousHistoryLines;
	resetMainScreenHistoryLines();
});

class RecordingTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class Spinner implements Component {
	frame = 0;
	settled: string | undefined;

	render(): string[] {
		if (this.settled !== undefined) return [this.settled];
		this.frame += 1;
		return [`spinner frame ${this.frame}`];
	}

	getRenderRevision(): number | undefined {
		return this.settled === undefined ? undefined : 1;
	}

	invalidate(): void {}
}

function mountTranscript(): {
	tui: TuiMainScreen;
	terminal: RecordingTerminal;
	transcript: ExplorationTranscriptContainer;
	scrolledSpinner: Spinner;
	visibleSpinner: Spinner;
	status: Text;
} {
	const terminal = new RecordingTerminal();
	const tui = new TuiMainScreen(terminal);
	const transcript = new ExplorationTranscriptContainer({
		tailBudget: 1000,
		warmChunkSize: 1000,
		requestRender: () => {},
	});
	const scrolledSpinner = new Spinner();
	transcript.addChild(new Text("first entry", 0, 0));
	transcript.addChild(scrolledSpinner);
	for (let index = 0; index < 300; index++) transcript.addChild(new Text(`history ${index}`, 0, 0));
	const visibleSpinner = new Spinner();
	transcript.addChild(visibleSpinner);
	const status = new Text("", 0, 0);
	const dock = new Container();
	dock.addChild(status);
	dock.addChild(new Text("editor", 0, 0));
	tui.addChild(transcript);
	tui.addChild(dock);
	tui.start();
	tui.renderNow();
	tui.renderNow();
	return { tui, terminal, transcript, scrolledSpinner, visibleSpinner, status };
}

function framesAfter(terminal: RecordingTerminal, from: number): string {
	return terminal.writes.slice(from).join("");
}

function toggleStatus(status: Text, frame: number): void {
	status.setText(frame % 2 === 0 ? `background event ${frame}` : "");
}

describe("live rows that scrolled into the terminal's history", () => {
	it("do not replay the whole transcript while status lines come and go", () => {
		// Given: a long transcript whose early entry is still animating, scrolled far above the screen
		const { tui, terminal, status } = mountTranscript();
		const before = terminal.writes.length;

		// When: background events show and clear a status line above the editor, frame after frame
		for (let frame = 0; frame < 20; frame++) {
			toggleStatus(status, frame);
			tui.renderNow();
		}

		// Then: the newest status reached the screen and no frame rewrote the scrollback
		const written = framesAfter(terminal, before);
		expect(written).toContain("background event 18");
		expect(written).not.toContain(SCROLLBACK_RESET);
		expect(written).not.toContain("history 0");
		tui.stop();
	});

	it("keep animating while they are still on screen", () => {
		// Given: a long transcript whose newest entry is animating on screen
		const { tui, terminal, visibleSpinner } = mountTranscript();
		const before = terminal.writes.length;

		// When: five more frames are painted
		for (let frame = 0; frame < 5; frame++) tui.renderNow();

		// Then: the on-screen entry shows its newest frame
		expect(framesAfter(terminal, before)).toContain(`spinner frame ${visibleSpinner.frame}`);
		tui.stop();
	});

	it("show their final content in the next full repaint", () => {
		// Given: an animating entry scrolled into history
		const { tui, terminal, scrolledSpinner } = mountTranscript();
		const before = terminal.writes.length;

		// When: it finishes and the screen is fully repainted (a redraw request or terminal reset)
		const lastScrolledFrame = `spinner frame ${scrolledSpinner.frame}\r`;
		scrolledSpinner.settled = "finished entry result";
		tui.renderNow(true);

		// Then: the repaint shows the final text, not a stale spinner frame
		const written = framesAfter(terminal, before);
		expect(written).toContain("finished entry result");
		expect(written).not.toContain(lastScrolledFrame);
		tui.stop();
	});

	it("are rendered again after the terminal width changes", () => {
		// Given: an animating entry scrolled into history
		const { tui, terminal, scrolledSpinner } = mountTranscript();
		const framesSoFar = scrolledSpinner.frame;

		// When: the terminal is resized, which repaints everything at the new width
		terminal.columns = 60;
		tui.renderNow();

		// Then: the entry was rendered for that repaint instead of reusing the old-width rows
		expect(scrolledSpinner.frame).toBeGreaterThan(framesSoFar);
		tui.stop();
	});
});
