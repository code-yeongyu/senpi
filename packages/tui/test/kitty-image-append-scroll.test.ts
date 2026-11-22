import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import { resetCapabilitiesCache, setCapabilities, setCellDimensions } from "../src/terminal-image.ts";
import type { TUI } from "../src/tui.ts";
import { type Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const COLUMNS = 245;
const ROWS = 61;
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=";

class Transcript implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	private writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
	takeWrites(): string {
		const joined = this.writes.join("");
		this.writes = [];
		return joined;
	}
}

function imageLines(widthPx: number, heightPx: number): string[] {
	return new Image(
		PNG_1X1,
		"image/png",
		{ fallbackColor: (value) => value },
		{ maxWidthCells: 60 },
		{
			widthPx,
			heightPx,
		},
	).render(COLUMNS);
}

function reservedRows(lines: readonly string[]): number {
	const match = /[,;]r=(\d+)/.exec(lines[0] ?? "");
	return match ? Number(match[1]) : 1;
}

async function startFullTranscript(): Promise<{ terminal: RecordingTerminal; tui: TUI; transcript: Transcript }> {
	const terminal = new RecordingTerminal(COLUMNS, ROWS);
	const tui: TUI = new TuiMainScreen(terminal);
	const transcript = new Transcript();
	tui.addChild(transcript);
	transcript.lines = Array.from({ length: 200 }, (_, i) => `history ${i}`);
	tui.start();
	await terminal.waitForRender();
	terminal.takeWrites();
	return { terminal, tui, transcript };
}

afterEach(() => {
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
});

describe("Kitty image appended below a full viewport (#4583)", () => {
	for (const [label, widthPx, heightPx] of [
		["390x844", 390, 844],
		["1440x900", 1440, 900],
	] as const) {
		for (const footerRows of [45, 5]) {
			it(`${label} image + ${footerRows} footer rows scrolls in place without clearing scrollback`, async () => {
				setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
				setCellDimensions({ widthPx: 8, heightPx: 16 });
				const { terminal, tui, transcript } = await startFullTranscript();
				const redrawsBefore = tui.fullRedraws;
				const image = imageLines(widthPx, heightPx);
				assert.ok(reservedRows(image) > 1 && reservedRows(image) <= ROWS, "fixture image must fit the viewport");

				transcript.lines = [
					...transcript.lines,
					...image,
					...Array.from({ length: footerRows }, (_, i) => `footer ${i}`),
				];
				tui.requestRender();
				await terminal.waitForRender();
				const frame = terminal.takeWrites();

				assert.ok(!frame.includes("\x1b[2J"), "append must not clear the screen");
				assert.ok(!frame.includes("\x1b[3J"), "append must not clear scrollback");
				assert.ok(!frame.includes("history 0"), "append must not replay old history");
				assert.strictEqual(tui.fullRedraws, redrawsBefore);
				assert.strictEqual(frame.split("\x1b[?2026h").length - 1, 1, "one synchronized-output begin");
				assert.strictEqual(frame.split("\x1b[?2026l").length - 1, 1, "one synchronized-output end");

				const buffer = terminal.getScrollBuffer().map((line) => line.trimEnd());
				assert.strictEqual(buffer[0], "history 0", "native scrollback keeps the oldest row");
				const viewport = terminal.getViewport().map((line) => line.trimEnd());
				assert.strictEqual(viewport[ROWS - 1], `footer ${footerRows - 1}`);
				const lastHistory = buffer.lastIndexOf("history 199");
				assert.strictEqual(buffer.indexOf(`footer 0`), lastHistory + image.length + 1, "image rows sit between");

				tui.requestRender();
				await terminal.waitForRender();
				assert.strictEqual(terminal.takeWrites(), "", "an unchanged frame writes nothing");
				tui.stop();
			});
		}
	}

	it("keeps short-history image appends on the differential path", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 8, heightPx: 16 });
		const terminal = new RecordingTerminal(COLUMNS, ROWS);
		const tui: TUI = new TuiMainScreen(terminal);
		const transcript = new Transcript();
		tui.addChild(transcript);
		transcript.lines = Array.from({ length: 10 }, (_, i) => `history ${i}`);
		tui.start();
		await terminal.waitForRender();
		terminal.takeWrites();

		transcript.lines = [...transcript.lines, ...imageLines(1440, 900), "footer"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(!terminal.takeWrites().includes("\x1b[2J"));
		tui.stop();
	});
});
