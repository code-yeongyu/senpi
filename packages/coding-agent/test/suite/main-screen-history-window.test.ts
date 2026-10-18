import { resetMainScreenHistoryLines, type Terminal, Text, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";

const MESSAGES = 10_000 as const;
const HISTORY_LINES = 300 as const;

class RecordingTerminal implements Terminal {
	columns = 100;
	rows = 30;
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

	get output(): string {
		return this.writes.join("");
	}
}

function transcriptOf(count: number): ExplorationTranscriptContainer {
	const transcript = new ExplorationTranscriptContainer({
		tailBudget: 60,
		warmChunkSize: 500,
		requestRender: () => {},
	});
	for (let index = 0; index < count; index++) transcript.addChild(new Text(`message ${index}`, 0, 0));
	return transcript;
}

async function hydrate(): Promise<void> {
	for (let tick = 0; tick < 200; tick++) await new Promise<void>((resolve) => setImmediate(resolve));
}

let previousHistoryLines: string | undefined;

beforeEach(() => {
	previousHistoryLines = process.env.PI_TUI_HISTORY_LINES;
	process.env.PI_TUI_HISTORY_LINES = String(HISTORY_LINES);
	resetMainScreenHistoryLines();
});

afterEach(() => {
	if (previousHistoryLines === undefined) delete process.env.PI_TUI_HISTORY_LINES;
	else process.env.PI_TUI_HISTORY_LINES = previousHistoryLines;
	resetMainScreenHistoryLines();
});

describe("the main screen keeps a bounded history of a huge session", () => {
	it("writes only the recent history after a resume, under a marker that counts the rest", async () => {
		// Given: a 10,000-message session resumed in the regular (main-screen) mode
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		tui.addChild(transcriptOf(MESSAGES));
		tui.start();
		tui.renderNow();

		// When: background hydration finishes and the history is published
		await hydrate();
		tui.renderNow();

		// Then: the terminal received the recent messages and a marker naming the left-out count, not the session
		const output = terminal.output;
		expect(output).toContain(`message ${MESSAGES - 1}`);
		expect(output).not.toContain("message 0\r");
		const hidden = Number(
			/(\d[\d,]*) earlier messages · \/tree to browse, or switch to fullscreen/
				.exec(output)?.[1]
				?.replaceAll(",", ""),
		);
		const firstKept = Number(/message (\d+)/.exec(output.slice(output.indexOf("earlier messages")))?.[1]);
		expect(hidden).toBe(firstKept);
		expect(MESSAGES - firstKept).toBeGreaterThanOrEqual(HISTORY_LINES);
		expect(MESSAGES - firstKept).toBeLessThanOrEqual(HISTORY_LINES * 2);
		tui.stop();
	});

	it("never keeps less than two screens of history", async () => {
		// Given: a tiny configured history and a tall terminal
		process.env.PI_TUI_HISTORY_LINES = "5";
		resetMainScreenHistoryLines();
		const terminal = new RecordingTerminal();
		terminal.rows = 40;
		const tui = new TuiMainScreen(terminal);
		tui.addChild(transcriptOf(1000));
		tui.start();
		tui.renderNow();
		await hydrate();
		tui.renderNow();

		// Then: at least 80 messages (two 40-row screens) were written above the marker
		const output = terminal.output;
		const firstKept = Number(/message (\d+)/.exec(output.slice(output.indexOf("earlier messages")))?.[1]);
		expect(1000 - firstKept).toBeGreaterThanOrEqual(80);
		tui.stop();
	});

	it("does not rewrite history as new messages arrive", async () => {
		// Given: a resumed huge session whose kept history is painted
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const transcript = transcriptOf(MESSAGES);
		tui.addChild(transcript);
		tui.start();
		tui.renderNow();
		await hydrate();
		tui.renderNow();
		const before = terminal.writes.length;

		// When: 50 new messages arrive one by one
		for (let index = 0; index < 50; index++) {
			transcript.addChild(new Text(`live ${index}`, 0, 0));
			tui.renderNow();
		}

		// Then: each was appended without a full repaint of the history
		const written = terminal.writes.slice(before).join("");
		expect(written).toContain("live 49");
		expect(written).not.toContain("\x1b[3J");
		expect(written).not.toContain("earlier messages");
		tui.stop();
	});

	it("still shows the very first message in fullscreen", async () => {
		// Given: the same huge session in fullscreen mode
		const terminal = new RecordingTerminal();
		const tui = new TuiAltScreen(terminal, false);
		const transcript = transcriptOf(MESSAGES);
		tui.addChild(transcript);
		tui.start();
		tui.renderNow();
		await hydrate();

		// When: fullscreen renders the transcript document
		const document = transcript.render(terminal.columns);

		// Then: nothing is left out and there is no marker
		expect(document[0]).toContain("message 0");
		expect(document.some((line) => line.includes("earlier messages"))).toBe(false);
		tui.stop();
	});

	it("keeps every message mounted and returns the full history after leaving the main screen", async () => {
		// Given: a huge session painted with a bounded main-screen history
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const transcript = transcriptOf(MESSAGES);
		tui.addChild(transcript);
		tui.start();
		tui.renderNow();
		await hydrate();
		tui.renderNow();

		// When: the transcript is rendered outside the main screen (fullscreen after a mode switch) and warms
		transcript.render(terminal.columns);
		await hydrate();
		const full = transcript.render(terminal.columns);

		// Then: every message is still mounted and the full history, starting at the first message, comes back
		expect(transcript.children).toHaveLength(MESSAGES);
		expect(full[0]).toContain("message 0");
		expect(full.some((line) => line.includes("earlier messages"))).toBe(false);
		tui.stop();
	});

	it("shows messages that scrolled above the kept history with their latest content in fullscreen", async () => {
		// Given: a long regular-mode run whose kept history has moved past its first messages
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const transcript = transcriptOf(500);
		const early = transcript.children[3] as Text;
		tui.addChild(transcript);
		tui.start();
		tui.renderNow();
		await hydrate();
		for (let index = 0; index < 1500; index++) {
			transcript.addChild(new Text(`live ${index}`, 0, 0));
			if (index % 50 === 0) tui.renderNow();
		}
		tui.renderNow();
		expect(terminal.writes.slice(-5).join("")).not.toContain("message 3\r");

		// When: that early message changes, and the user switches to fullscreen
		early.setText("message 3 (edited)");
		tui.stop();
		const fullscreen = new TuiAltScreen(new RecordingTerminal(), false);
		fullscreen.addChild(transcript);
		fullscreen.start();
		fullscreen.renderNow();
		await hydrate();
		const document = transcript.render(terminal.columns);

		// Then: every message is there in order, the early one with its latest text
		expect(document[0]).toContain("message 0");
		expect(document[3]).toContain("message 3 (edited)");
		expect(document.at(-1)).toContain("live 1499");
		expect(document).toHaveLength(2000);
		fullscreen.stop();
	});
});
