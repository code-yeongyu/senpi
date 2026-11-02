import assert from "node:assert";
import { describe, it } from "node:test";
import { Container, Text } from "../src/index.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Regression #2836: while a reply streams, content that re-lays out rows above the viewport (a streamed
 * table re-sizing its columns) made every frame replay the whole scrollback (ESC[3J + full rewrite), which
 * throws a user who scrolled up back to the top. With the hold on, such frames repaint only the viewport,
 * and the stale rows are corrected exactly once at the next key press.
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
	allRows(): string[] {
		const buffer = this.emulator.buffer.active;
		const rows: string[] = [];
		for (let row = 0; row < buffer.length; row++) rows.push(buffer.getLine(row)?.translateToString(true) ?? "");
		return rows;
	}
}

interface XtermLike {
	scrollLines(amount: number): void;
	buffer: {
		active: {
			viewportY: number;
			length: number;
			getLine(row: number): { translateToString(trim: boolean): string } | undefined;
		};
	};
}

/** A streamed table whose column width grows with each row, so every earlier row re-renders wider. */
function growingTable(rows: number): string {
	const lines = ["| name | value |"];
	for (let row = 0; row < rows; row++) lines.push(`| r${"x".repeat(row)} | v${row} |`);
	const width = Math.max(...lines.map((line) => line.length));
	return lines.map((line) => line.padEnd(width, ".")).join("\n");
}

function setup(muxDetector: () => boolean = () => false) {
	const terminal = new CountingTerminal(60, 12);
	const ui = new TUI(terminal, { muxDetector });
	const chat = new Container();
	for (let index = 0; index < 6; index++) chat.addChild(new Text(`earlier ${index}`, 0, 0));
	const live = new Text("", 0, 0);
	chat.addChild(live);
	ui.addChild(chat);
	ui.addChild(new Text("> editor", 0, 0));
	ui.start();
	ui.renderNow();
	const stream = (rows: number) => {
		live.setText(growingTable(rows));
		ui.renderNow();
	};
	return { terminal, ui, stream };
}

describe("scrollback replay hold during a streaming reply (#2836)", () => {
	it("streams a table that re-lays out rows above the viewport without any scrollback replay", async () => {
		const { terminal, ui, stream } = setup();
		ui.setScrollbackReplayHold(true);
		for (let rows = 1; rows <= 30; rows++) stream(rows);
		await terminal.flush();
		assert.strictEqual(terminal.scrollbackClears, 0);
		assert.ok((await terminal.flushAndGetViewport()).join("\n").includes("v29"));
		ui.stop();
	});

	it("keeps a scrolled-up reader on the same row while the table keeps streaming", async () => {
		const { terminal, ui, stream } = setup();
		ui.setScrollbackReplayHold(true);
		for (let rows = 1; rows <= 15; rows++) stream(rows);
		await terminal.flush();
		terminal.scrollUp(6);
		const watching = terminal.topVisibleRow();
		for (let rows = 16; rows <= 30; rows++) stream(rows);
		await terminal.flush();
		assert.strictEqual(terminal.topVisibleRow(), watching);
		ui.stop();
	});

	it("corrects the stale rows exactly once, at the next key press after the turn ends", async () => {
		const { terminal, ui, stream } = setup();
		ui.setScrollbackReplayHold(true);
		for (let rows = 1; rows <= 30; rows++) stream(rows);
		ui.setScrollbackReplayHold("until-input");
		ui.renderNow();
		await terminal.flush();
		assert.strictEqual(terminal.scrollbackClears, 0, "no replay at turn end");
		const finalWidthBefore = growingTable(30).split("\n")[0].length;
		const rowsBefore = terminal.allRows().filter((row) => row.startsWith("| r"));
		assert.strictEqual(rowsBefore.length, 30, "every streamed row reached the scrollback during the turn");
		const staleBefore = rowsBefore.filter((row) => row.trimEnd().length !== finalWidthBefore);
		assert.ok(staleBefore.length > 0, "rows that scrolled off kept their older width until the catch-up");

		terminal.sendInput("a");
		ui.renderNow();
		await terminal.flush();
		assert.strictEqual(terminal.scrollbackClears, 1, "one catch-up replay on the key press");
		// Every table row in the whole buffer (scrollback included) is at the final width: none is left stale.
		const finalWidth = growingTable(30).split("\n")[0].length;
		const tableRows = terminal.allRows().filter((row) => row.startsWith("| r"));
		assert.ok(tableRows.length >= 30, `all 30 rows present (found ${tableRows.length})`);
		assert.deepStrictEqual([...new Set(tableRows.map((row) => row.trimEnd().length))], [finalWidth]);

		terminal.sendInput("b");
		ui.renderNow();
		await terminal.flush();
		assert.strictEqual(terminal.scrollbackClears, 1, "no second replay");
		ui.stop();
	});

	it("still replays immediately when idle (no hold), as before", async () => {
		const { terminal, ui, stream } = setup();
		for (let rows = 1; rows <= 30; rows++) stream(rows);
		await terminal.flush();
		assert.ok(terminal.scrollbackClears > 0);
		ui.stop();
	});

	it("leaves the multiplexer path unchanged: no scrollback replay with or without the hold", async () => {
		for (const hold of [false, true]) {
			const { terminal, ui, stream } = setup(() => true);
			if (hold) ui.setScrollbackReplayHold(true);
			for (let rows = 1; rows <= 30; rows++) stream(rows);
			await terminal.flush();
			assert.strictEqual(terminal.scrollbackClears, 0);
			ui.stop();
		}
	});

	it("does not catch up on terminal reports while the reader is still scrolled up (wheel, theme flip, replies)", async () => {
		const { terminal, ui, stream } = setup();
		ui.setScrollbackReplayHold(true);
		for (let rows = 1; rows <= 30; rows++) stream(rows);
		ui.setScrollbackReplayHold("until-input");
		await terminal.flush();
		terminal.scrollUp(6);
		const watching = terminal.topVisibleRow();

		for (const report of [
			"\x1b[<65;10;5M", // mouse wheel
			"\x1b[?997;1n", // OS theme flipped (color-scheme report)
			"\x1b[6;20;10t", // cell-size reply
			"\x1b]11;rgb:0000/0000/0000\x07", // late OSC color reply
		]) {
			terminal.sendInput(report);
			ui.renderNow();
		}
		await terminal.flush();

		assert.strictEqual(terminal.scrollbackClears, 0);
		assert.strictEqual(terminal.topVisibleRow(), watching);
		ui.stop();
	});

	it("after the turn, the next key releases the hold so later updates render normally again", async () => {
		const { terminal, ui, stream } = setup();
		ui.setScrollbackReplayHold(true);
		for (let rows = 1; rows <= 20; rows++) stream(rows);
		ui.setScrollbackReplayHold("until-input");
		stream(21);
		await terminal.flush();
		assert.strictEqual(terminal.scrollbackClears, 0, "still held after the turn, before any key");

		terminal.sendInput("a");
		ui.renderNow();
		const afterKey = terminal.scrollbackClears;
		assert.strictEqual(afterKey, 1, "the key catches up once");
		for (let rows = 22; rows <= 30; rows++) stream(rows);
		await terminal.flush();
		assert.ok(
			terminal.scrollbackClears > afterKey,
			"released: an idle update that re-lays out rows above replays again",
		);
		ui.stop();
	});

	it("keeps the hold across a stop()/start() handover in the middle of a turn (external editor, suspend)", async () => {
		const { terminal, ui, stream } = setup();
		ui.setScrollbackReplayHold(true);
		for (let rows = 1; rows <= 15; rows++) stream(rows);
		ui.stop();
		ui.start();
		ui.renderNow(true);
		await terminal.flush();
		const clearsAfterHandover = terminal.scrollbackClears;
		for (let rows = 16; rows <= 30; rows++) stream(rows);
		await terminal.flush();
		assert.strictEqual(terminal.scrollbackClears, clearsAfterHandover);
		ui.stop();
	});

	it("counts a legacy Alt+] or Alt+Shift+P key press as a key, not as a terminal report", async () => {
		for (const key of ["\x1b]", "\x1bP", "\x1b_"]) {
			const { terminal, ui, stream } = setup();
			ui.setScrollbackReplayHold(true);
			for (let rows = 1; rows <= 30; rows++) stream(rows);
			ui.setScrollbackReplayHold("until-input");
			terminal.sendInput(key);
			ui.renderNow();
			await terminal.flush();
			assert.strictEqual(terminal.scrollbackClears, 1, `catch-up on ${JSON.stringify(key)}`);
			ui.stop();
		}
	});
});
