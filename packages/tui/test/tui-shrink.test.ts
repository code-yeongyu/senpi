import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

async function renderNow(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.renderNow();
	await terminal.flush();
}

function trailingBlankRows(lines: string[]): number {
	let count = 0;
	for (let index = lines.length - 1; index >= 0 && lines[index]?.trim() === ""; index--) {
		count += 1;
	}
	return count;
}

describe("TUI shrinking content", () => {
	it("keeps a shrunken document tail flush with the buffer bottom", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const history = Array.from({ length: 12 }, (_, index) => `history ${index}`);
		const collapsedTail = [`${CURSOR_MARKER}editor`, "status", "footer"];
		const visibleCollapsedTail = ["editor", "status", "footer"];
		const expandedTail = Array.from({ length: 8 }, (_, index) => `selector ${index}`);
		const content = new Lines([...history, ...collapsedTail]);
		tui.addChild(content);

		await renderNow(tui, terminal);
		content.setLines([...history, ...expandedTail]);
		await renderNow(tui, terminal);
		assert.strictEqual(trailingBlankRows(terminal.getScrollBuffer()), 0, "expanded tail should be flush");
		const expandedBufferLength = terminal.getScrollBuffer().length;
		terminal.clearWrites();

		content.setLines([...history, ...collapsedTail]);
		await renderNow(tui, terminal);

		const shrinkWrites = terminal.getWrites();
		assert.strictEqual(trailingBlankRows(terminal.getScrollBuffer()), 0, "shrunken tail should stay flush");
		assert.deepStrictEqual(terminal.getViewport().slice(-3), visibleCollapsedTail);
		assert.strictEqual(terminal.getCursorPosition().y, 7, "hardware cursor should follow the anchored editor row");
		assert.ok(!shrinkWrites.includes("\x1b[2J"), "shrink should not clear the screen");
		assert.ok(!shrinkWrites.includes("\x1b[3J"), "shrink should not clear scrollback");
		assert.ok(
			shrinkWrites.split("\x1b[2K").length - 1 <= terminal.rows,
			"shrink repaint work should be bounded by the viewport",
		);
		for (const line of ["history 0", ...visibleCollapsedTail]) {
			assert.strictEqual(
				terminal.getScrollBuffer().filter((bufferLine) => bufferLine === line).length,
				1,
				`shrink should not replay ${line}`,
			);
		}

		const renderState = tui.captureRenderState();
		tui.stop({ preserveScreen: true });
		const restoredTui = new TuiMainScreen(terminal);
		restoredTui.restoreRenderState(renderState);
		restoredTui.addChild(content);

		content.setLines([...history, "popup 0", "popup 1", ...collapsedTail]);
		await renderNow(restoredTui, terminal);
		assert.strictEqual(
			terminal.getScrollBuffer().length,
			expandedBufferLength,
			"growth should consume the restored blank gap before extending scrollback",
		);
		assert.strictEqual(trailingBlankRows(terminal.getScrollBuffer()), 0, "tail should stay flush after regrowth");
		assert.deepStrictEqual(terminal.getViewport().slice(-3), visibleCollapsedTail);

		restoredTui.stop();
	});

	it("clears all rendered lines when content shrinks to zero", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const content = new Lines(["first", "second", "third"]);
		tui.addChild(content);
		tui.start();
		await renderNow(tui, terminal);

		assert.ok(terminal.getViewport().some((line) => line.includes("first")));
		assert.ok(terminal.getViewport().some((line) => line.includes("second")));
		assert.ok(terminal.getViewport().some((line) => line.includes("third")));

		tui.clear();
		await renderNow(tui, terminal);

		const viewport = terminal.getViewport();
		assert.ok(!viewport.some((line) => line.includes("first")), "first line should be cleared");
		assert.ok(!viewport.some((line) => line.includes("second")), "second line should be cleared");
		assert.ok(!viewport.some((line) => line.includes("third")), "third line should be cleared");

		tui.stop();
	});
});
