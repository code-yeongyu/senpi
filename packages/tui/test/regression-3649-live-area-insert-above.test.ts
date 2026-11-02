import assert from "node:assert";
import { describe, it } from "node:test";
import { Container, Text } from "../src/index.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Regression senpi#3649: with a tall /btw panel the live area (status, panel, editor) fills the screen, so a
 * running eval's output grows at or above the viewport top. Those frames must not scroll stale live-area rows
 * into the scrollback or drop the eval rows: every row lands in the scrollback exactly once.
 */
class RecordingTerminal extends VirtualTerminal {
	writes = "";
	override write(data: string): void {
		this.writes += data;
		super.write(data);
	}
}

const BTW_PANEL = ["btw: QUESTION", ...Array.from({ length: 8 }, (_, index) => `answer ${index}`), "btw end"];

function setup(options: { mux: boolean; cardFooterRows: number; repeatedRowsAboveLiveArea?: number; rows?: number }) {
	const terminal = new RecordingTerminal(60, options.rows ?? 12);
	const ui = new TUI(terminal, { muxDetector: () => options.mux });
	const transcript = new Container();
	for (let index = 0; index < 6; index++) transcript.addChild(new Text(`earlier ${index}`, 0, 0));
	const evalOutput = new Text("eval line 0", 0, 0);
	transcript.addChild(evalOutput);
	for (let index = 0; index < options.cardFooterRows; index++) {
		transcript.addChild(new Text(`card footer ${index}`, 0, 0));
	}
	for (let index = 0; index < (options.repeatedRowsAboveLiveArea ?? 0); index++) {
		transcript.addChild(new Text("same row", 0, 0));
	}
	ui.addChild(transcript);
	const status = new Text("Running eval (0s)", 0, 0);
	ui.addChild(status);
	ui.addChild(new Text(BTW_PANEL.join("\n"), 0, 0));
	ui.addChild(new Text("> editor", 0, 0));
	ui.start();
	ui.renderNow();
	const evalLines = ["eval line 0"];
	const tick = (second: number) => {
		evalLines.push(`eval line ${second}`);
		evalOutput.setText(evalLines.join("\n"));
		status.setText(`Running eval (${second}s)`);
		ui.renderNow();
	};
	return { terminal, ui, tick };
}

function nonBlankRows(terminal: VirtualTerminal): string[] {
	return terminal
		.getScrollBuffer()
		.map((row) => row.trimEnd())
		.filter((row) => row.length > 0);
}

function duplicates(rows: readonly string[]): string[] {
	return rows.filter((row, index) => rows.indexOf(row) !== index);
}

const evalRows = (count: number) => Array.from({ length: count + 1 }, (_, index) => `eval line ${index}`);

describe("eval output growing above a tall live area (#3649)", () => {
	it("keeps every eval row and one copy of the live area when rows are inserted at the viewport top", async () => {
		for (const mux of [false, true]) {
			const { terminal, ui, tick } = setup({ mux, cardFooterRows: 0 });
			terminal.writes = "";
			for (let second = 1; second <= 20; second++) tick(second);
			await terminal.flush();
			const rows = nonBlankRows(terminal);
			assert.deepStrictEqual(duplicates(rows), [], `mux=${mux}: no row reaches the buffer twice`);
			for (const row of evalRows(20)) assert.ok(rows.includes(row), `mux=${mux}: ${row} kept`);
			assert.strictEqual(rows.filter((row) => row === BTW_PANEL[0]).length, 1);
			assert.ok(!/\x1b\[1;\d+r/.test(terminal.writes), `mux=${mux}: no scroll-region shift of stale rows`);
			ui.stop();
		}
	});

	it("does not push copies of the live area into the scrollback while a turn holds the replay", async () => {
		const { terminal, ui, tick } = setup({ mux: false, cardFooterRows: 2 });
		ui.setScrollbackReplayHold(true);
		for (let second = 1; second <= 20; second++) tick(second);
		await terminal.flush();
		const rows = nonBlankRows(terminal);
		assert.deepStrictEqual(duplicates(rows), []);
		assert.strictEqual(rows.filter((row) => row === BTW_PANEL[0]).length, 1);
		assert.deepStrictEqual((await terminal.flushAndGetViewport()).at(-1)?.trimEnd(), "> editor");
		ui.stop();
	});

	it("detects an insertion above when identical rows sit right above the live area", async () => {
		const { terminal, ui, tick } = setup({ mux: false, cardFooterRows: 1, repeatedRowsAboveLiveArea: 3, rows: 13 });
		ui.setScrollbackReplayHold(true);
		for (let second = 1; second <= 20; second++) tick(second);
		await terminal.flush();
		const rows = nonBlankRows(terminal);
		assert.deepStrictEqual(
			duplicates(rows).filter((row) => row !== "same row"),
			[],
		);
		assert.strictEqual(rows.filter((row) => row === "same row").length, 3);
		assert.strictEqual(rows.filter((row) => row === BTW_PANEL[0]).length, 1);
		ui.stop();
	});

	it("restores the held eval rows exactly once at the catch-up after the turn", async () => {
		const { terminal, ui, tick } = setup({ mux: false, cardFooterRows: 2 });
		ui.setScrollbackReplayHold(true);
		for (let second = 1; second <= 20; second++) tick(second);
		ui.setScrollbackReplayHold("until-input");
		terminal.sendInput("a");
		ui.renderNow();
		await terminal.flush();
		const rows = nonBlankRows(terminal);
		assert.deepStrictEqual(duplicates(rows), []);
		for (const row of evalRows(20)) assert.ok(rows.includes(row), `${row} restored`);
		assert.ok(rows.indexOf("eval line 20") < rows.indexOf("card footer 0"));
		ui.stop();
	});

	it("does not read an in-place re-layout plus an append under a tall live area as an insertion above", async () => {
		const terminal = new RecordingTerminal(60, 12);
		const ui = new TUI(terminal, { muxDetector: () => false });
		const header = new Text("card header 0", 0, 0);
		const table = new Text("", 0, 0);
		ui.addChild(header);
		ui.addChild(table);
		ui.addChild(new Text(Array.from({ length: 7 }, (_, index) => `live row ${index}`).join("\n"), 0, 0));
		const layOut = (rows: number) => {
			const width = 6 + rows;
			table.setText(Array.from({ length: rows }, (_, index) => `row ${index} `.padEnd(width, "w")).join("\n"));
		};
		layOut(6);
		ui.start();
		ui.renderNow();
		ui.setScrollbackReplayHold(true);
		for (let tick = 1; tick <= 6; tick++) {
			header.setText(`card header ${tick}`);
			layOut(6 + tick);
			ui.renderNow();
		}
		await terminal.flush();
		const rows = nonBlankRows(terminal);
		for (let index = 0; index < 12; index++) {
			assert.ok(
				rows.some((row) => row.startsWith(`row ${index} `)),
				`row ${index} is in the buffer during the turn (stale width allowed)`,
			);
		}
		ui.stop();
	});

	it("does not take identical rows across the viewport top for an insertion above on a plain append", async () => {
		const terminal = new RecordingTerminal(60, 12);
		const ui = new TUI(terminal, { muxDetector: () => false });
		const header = new Text("card header 0", 0, 0);
		const table = new Text("", 0, 0);
		ui.addChild(header);
		ui.addChild(table);
		ui.addChild(new Text(Array.from({ length: 7 }, (_, index) => `live row ${index}`).join("\n"), 0, 0));
		table.setText(Array.from({ length: 3 }, () => "dup").join("\n"));
		ui.start();
		ui.renderNow();
		ui.setScrollbackReplayHold(true);
		for (let tick = 1; tick <= 4; tick++) {
			header.setText(`card header ${tick}`);
			table.setText(Array.from({ length: 3 + tick }, () => "dup").join("\n"));
			ui.renderNow();
		}
		await terminal.flush();
		assert.strictEqual(
			nonBlankRows(terminal).filter((row) => row === "dup").length,
			7,
			"every appended row reaches the buffer during the turn",
		);
		ui.stop();
	});

	it("leaves the multiplexer path free of duplicates when rows are inserted above the viewport", async () => {
		const { terminal, ui, tick } = setup({ mux: true, cardFooterRows: 2 });
		ui.setScrollbackReplayHold(true);
		for (let second = 1; second <= 20; second++) tick(second);
		await terminal.flush();
		assert.deepStrictEqual(duplicates(nonBlankRows(terminal)), []);
		ui.stop();
	});
});
