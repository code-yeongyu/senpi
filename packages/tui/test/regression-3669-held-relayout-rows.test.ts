import assert from "node:assert";
import { describe, it } from "node:test";
import { Container, Text } from "../src/index.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Regression senpi#3669: with the scrollback replay hold on, a held frame must never leave a row that was on
 * screen out of the buffer. A streamed table that re-lays out while growing (a wrapped cell above the viewport
 * unwraps as its column widens) moves the old top row above the viewport, and a repaint from the old viewport
 * top overwrote it (the #2836 gap). Rows are keyed by their label, so a stale width in the buffer still counts.
 */
const rowKey = (row: string) => row.trimEnd().split(" ").slice(0, 2).join(" ");

function nonBlankRows(terminal: VirtualTerminal): string[] {
	return terminal
		.getScrollBuffer()
		.map((row) => row.trimEnd())
		.filter((row) => row.length > 0);
}

describe("held repaint keeps every row that was on screen (#3669)", () => {
	it("keeps the old top row when a table re-lays out above the viewport while it grows", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const ui = new TUI(terminal, { muxDetector: () => false });
		const header = new Text("card header 0", 0, 0);
		const table = new Text("", 0, 0);
		ui.addChild(header);
		ui.addChild(table);
		ui.addChild(new Text(Array.from({ length: 7 }, (_, index) => `live row ${index}`).join("\n"), 0, 0));
		const layOut = (rows: number, firstRowWrapped: boolean) => {
			const lines = Array.from({ length: rows }, (_, index) => `row ${index} `.padEnd(6 + rows, "w"));
			if (firstRowWrapped) lines.splice(1, 0, "  row 0 continued");
			table.setText(lines.join("\n"));
		};
		layOut(6, true);
		ui.start();
		ui.renderNow();
		ui.setScrollbackReplayHold(true);
		const seen = new Set<string>();
		const recordScreen = async () => {
			for (const row of await terminal.flushAndGetViewport()) if (row.trim()) seen.add(rowKey(row));
		};
		await recordScreen();
		for (let tick = 1; tick <= 6; tick++) {
			header.setText(`card header ${tick}`);
			layOut(6 + tick, tick < 2);
			ui.renderNow();
			await recordScreen();
			const buffer = new Set(terminal.getScrollBuffer().map(rowKey));
			const missing = [...seen].filter((key) => !buffer.has(key));
			assert.deepStrictEqual(missing, [], `tick ${tick}: every row seen on screen is in the buffer`);
		}
		const tableKeys = nonBlankRows(terminal)
			.map(rowKey)
			.filter((key) => key.startsWith("row "));
		assert.deepStrictEqual(
			tableKeys.filter((key, index) => tableKeys.indexOf(key) !== index),
			[],
			"no table row reaches the buffer twice",
		);
		ui.stop();
	});

	it("detects an insertion above past identical rows longer than twice the screen height", async () => {
		const terminal = new VirtualTerminal(60, 13);
		const ui = new TUI(terminal, { muxDetector: () => false });
		const transcript = new Container();
		const evalOutput = new Text("eval line 0", 0, 0);
		transcript.addChild(evalOutput);
		transcript.addChild(new Text("card footer", 0, 0));
		transcript.addChild(new Text(Array.from({ length: 30 }, () => "same row").join("\n"), 0, 0));
		ui.addChild(transcript);
		const status = new Text("Running eval (0s)", 0, 0);
		ui.addChild(status);
		ui.addChild(
			new Text(["btw: QUESTION", ...Array.from({ length: 9 }, (_, index) => `answer ${index}`)].join("\n"), 0, 0),
		);
		ui.addChild(new Text("> editor", 0, 0));
		ui.start();
		ui.renderNow();
		ui.setScrollbackReplayHold(true);
		const evalLines = ["eval line 0"];
		for (let second = 1; second <= 10; second++) {
			evalLines.push(`eval line ${second}`);
			evalOutput.setText(evalLines.join("\n"));
			status.setText(`Running eval (${second}s)`);
			ui.renderNow();
		}
		await terminal.flush();
		const rows = nonBlankRows(terminal);
		const unique = rows.filter((row) => row !== "same row");
		assert.deepStrictEqual(
			unique.filter((row, index) => unique.indexOf(row) !== index),
			[],
		);
		assert.strictEqual(rows.filter((row) => row === "same row").length, 30, "the repeated rows are not pushed again");
		ui.stop();
	});
});
