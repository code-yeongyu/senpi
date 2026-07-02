import assert from "node:assert";
import { describe, it, test } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Image } from "../src/components/image.ts";
import {
	deleteKittyImage,
	encodeKitty,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class EchoInputComponent implements Component {
	text = "";

	render(_width: number): string[] {
		return [`input:${this.text}`];
	}

	handleInput(data: string): void {
		this.text += data;
	}

	invalidate(): void {}
}

class StreamingBudgetComponent implements Component {
	private tokenCount = 0;
	readonly stableTail = Array.from({ length: 18 }, (_, index) => `stable viewport row ${index}`);

	appendToken(): void {
		this.tokenCount += 1;
	}

	render(_width: number): string[] {
		return [`streamed tokens ${this.tokenCount}`, ...this.stableTail];
	}

	invalidate(): void {}
}

class ExpandableTranscriptComponent implements Component {
	private expanded = false;
	readonly tail = Array.from({ length: 6 }, (_, index) => `tail row ${index}`);

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(_width: number): string[] {
		const prefix = ["session title", "tools"];
		if (!this.expanded) {
			return [...prefix, ...this.tail];
		}
		const inserted = Array.from({ length: 16 }, (_, index) => `expanded tool detail ${index}`);
		return [...prefix, ...inserted, ...this.tail];
	}

	invalidate(): void {}
}

class MultipleExpandableToolTranscriptComponent implements Component {
	private expanded = false;
	readonly tail = Array.from({ length: 8 }, (_, index) => `tail row ${index}`);

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	render(_width: number): string[] {
		const readBlock = this.expanded
			? [
					"read expanded lib.rs:210",
					"pub until: Option<String>,",
					"pub year: Option<String>,",
					"pub scanner_settings: scanner::ScannerSettings,",
					"pub struct DailyTotals {",
					"pub tokens: i64,",
				]
			: ["read collapsed lib.rs:210-329"];
		const toolBlock = this.expanded
			? ["tool expanded bash", "stdout line 0", "stdout line 1", "stdout line 2", "stdout line 3", "stdout line 4"]
			: ["tool collapsed bash output"];
		return [...readBlock, ...toolBlock, ...this.tail];
	}

	invalidate(): void {}
}

class ExpandedStreamingOutputComponent implements Component {
	private outputLineCount = 12;
	readonly stableTail = ["loader row", "editor row", "footer row"];

	appendOutputLine(): void {
		this.outputLineCount += 1;
	}

	render(_width: number): string[] {
		const output = Array.from({ length: this.outputLineCount }, (_, index) => `expanded output ${index}`);
		return ["tool header", ...output, ...this.stableTail];
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

interface FlickerBudgetMetrics {
	ansiByteRatio: number;
	begin2026Count: number;
	clearCount: number;
	contentBytes: number;
	escapeBytes: number;
	fullRenderTrueAfterInit: number;
	initialClearCount: number;
	inputBytes: number;
	end2026Count: number;
	writeBytes: number;
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

function countEscapeBytes(text: string): number {
	const matches = text.match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\)|[@-_])/g);
	return matches?.reduce((total, match) => total + Buffer.byteLength(match), 0) ?? 0;
}

function getScrollbackSuffix(scrollback: string[], lineCount: number): string[] {
	return scrollback.slice(Math.max(0, scrollback.length - lineCount));
}

function logFlickerBudgetMetrics(testName: string, metrics: FlickerBudgetMetrics): void {
	console.log(
		`flicker-budget ${testName}: clear=${metrics.clearCount}, initialClear=${metrics.initialClearCount}, fullRenderTrueAfterInit=${metrics.fullRenderTrueAfterInit}, ansiRatio=${metrics.ansiByteRatio.toFixed(3)}, decset=${metrics.begin2026Count}/${metrics.end2026Count}, escapeBytes=${metrics.escapeBytes}, contentBytes=${metrics.contentBytes}, writeBytes=${metrics.writeBytes}`,
	);
}

async function runStreamingFlickerBudget(): Promise<FlickerBudgetMetrics> {
	const terminal = new LoggingVirtualTerminal(72, 8);
	const tui = new TUI(terminal);
	const component = new StreamingBudgetComponent();
	tui.addChild(component);

	// given
	tui.start();
	await terminal.waitForRender();
	tui.requestRender(true);
	await terminal.waitForRender();
	const initialWrites = terminal.getWrites();
	const initialClearCount = countOccurrences(initialWrites, "\x1b[2J\x1b[H\x1b[3J");
	let inputBytes = 0;

	// when
	for (let tokenIndex = 0; tokenIndex < 120; tokenIndex++) {
		component.appendToken();
		inputBytes += Buffer.byteLength(String(tokenIndex));
		tui.requestRender();
		await terminal.waitForRender();
	}

	// then
	const writes = terminal.getWrites();
	const clearCount = countOccurrences(writes, "\x1b[2J\x1b[H\x1b[3J");
	const escapeBytes = countEscapeBytes(writes);
	const writeBytes = Buffer.byteLength(writes);
	const contentBytes = Math.max(inputBytes, writeBytes - escapeBytes);
	const metrics = {
		ansiByteRatio: escapeBytes / Math.max(1, contentBytes),
		begin2026Count: countOccurrences(writes, "\x1b[?2026h"),
		clearCount,
		contentBytes,
		escapeBytes,
		fullRenderTrueAfterInit: Math.max(0, clearCount - initialClearCount),
		initialClearCount,
		inputBytes,
		end2026Count: countOccurrences(writes, "\x1b[?2026l"),
		writeBytes,
	} satisfies FlickerBudgetMetrics;

	tui.stop();
	return metrics;
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xtermValue: unknown = Reflect.get(terminal, "xterm");
	assert.ok(isXtermTerminal(xtermValue), "VirtualTerminal should expose an xterm instance in tests");
	const xterm = xtermValue;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

function isXtermTerminal(value: unknown): value is XtermTerminalType {
	return typeof value === "object" && value !== null && "buffer" in value;
}

describe("TUI lifecycle memory", () => {
	it("releases rendered line cache after stop", async () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["first", "second"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		const previousLinesBeforeStop = Reflect.get(tui, "previousLines");
		assert.ok(Array.isArray(previousLinesBeforeStop));
		assert.ok(previousLinesBeforeStop.length > 0);

		tui.stop();

		const previousLinesAfterStop = Reflect.get(tui, "previousLines");
		assert.deepEqual(previousLinesAfterStop, []);
	});
});

describe("TUI input render scheduling", () => {
	it("clears a dirty current line before the initial render", async () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// given
		terminal.write("12:21 \x1b[2mfrom-shell-prompt");
		component.lines = ["\x1b[1m•\x1b[22m \x1b[2mWorking\x1b[22m"];

		// when
		tui.start();
		await terminal.waitForRender();

		// then
		assert.strictEqual(terminal.getViewport()[0], "• Working");

		tui.stop();
	});

	it("echoes focused component input on the next tick while a normal render is pending", async () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new EchoInputComponent();
		tui.addChild(component);
		tui.setFocus(component);

		tui.start();
		await terminal.waitForRender();

		tui.requestRender();
		terminal.sendInput("ZQX");
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await terminal.flush();

		assert.equal(component.text, "ZQX");
		assert.ok(terminal.getViewport().join("\n").includes("input:ZQX"));

		tui.stop();
	});
});

describe("TUI Kitty image cleanup", () => {
	it("clears reserved Kitty image rows before drawing appended image placements", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(
				writes.includes(`\x1b[2K\x1b[0m\x1b]8;;\x07\r\n\x1b[2K\x1b[0m\x1b]8;;\x07\x1b[1A${imageSequence}\x1b[1B`),
				"reserved rows should be cleared before the image placement is drawn",
			);
			assert.ok(
				!writes.includes(`${imageSequence}\r\n\x1b[2K`),
				"reserved row clears must not run after the image placement is drawn",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("falls back to full redraw when Kitty image pre-clear would scroll", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 2);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			component.lines = ["before", ...image.render(40), "after"];
			tui.requestRender();
			await terminal.waitForRender();

			assert.ok(tui.fullRedraws > redrawsBeforeImage, "unsafe image pre-clear should force a full redraw");
			assert.ok(terminal.getWrites().includes("\x1b[2J"), "fallback should clear and fully redraw");

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("reserves Kitty image rows before drawing during full redraw fallbacks", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["l0", "l1", "l2", "l3", "l4"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["l0", "l1", "l2", "l3", "l4", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(tui.fullRedraws > redrawsBeforeImage, "scrolling image append should force a full redraw");
			assert.ok(
				writes.includes(`\r\n\r\n\x1b[2A${imageSequence}\x1b[2B`),
				"full redraw should reserve visible image rows before drawing the placement",
			);
			assert.ok(
				!writes.includes(`${imageSequence}\r\n\x1b[0m`),
				"full redraw must not write reserved padding rows after drawing the placement",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("does not use cursor-up placement for Kitty images taller than the viewport", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 6 },
				{ widthPx: 60, heightPx: 60 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			assert.ok(imageLines.length > terminal.rows, "test image should exceed the viewport height");

			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender(true);
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes(imageSequence), "image placement should be drawn");
			assert.ok(
				!writes.includes(`\x1b[${imageLines.length - 1}A${imageSequence}`),
				"taller-than-viewport images must keep the #4461 first-row placement path",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("deletes changed image ids before drawing moved placements", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		component.lines = ["top", oldImage];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const newImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		component.lines = [newImage, ""];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		const drawIndex = writes.indexOf(newImage);
		assert.ok(deleteIndex >= 0, "changed old image should be deleted");
		assert.ok(drawIndex >= 0, "new image should be drawn");
		assert.ok(deleteIndex < drawIndex, "old image must be deleted before the new placement is drawn");

		tui.stop();
	});

	it("redraws image lines when an earlier reserved image row changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 88, moveCursor: false });
		component.lines = ["", image];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["covered", image];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(88));
		const drawIndex = writes.indexOf(image);
		assert.ok(deleteIndex >= 0, "image should be deleted when a reserved row changes");
		assert.ok(drawIndex >= 0, "unchanged image line should be redrawn after deleting the placement");
		assert.ok(deleteIndex < drawIndex, "old placement must be deleted before the image line is redrawn");
		assert.ok(!writes.includes("\x1b[2J"), "reserved row changes should not force a full redraw");

		tui.stop();
	});

	it("deletes previously rendered image ids during full redraws", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = [encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 77, moveCursor: false })];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["plain text"];
		tui.requestRender(true);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(77));
		const clearIndex = writes.indexOf("\x1b[2J");
		assert.ok(deleteIndex >= 0, "previous image should be deleted during full redraw");
		assert.ok(clearIndex >= 0, "full redraw should clear the screen");
		assert.ok(deleteIndex < clearIndex, "old image should be deleted before the screen is cleared");

		tui.stop();
	});
});

describe("TUI resize handling", () => {
	it("triggers full re-render when terminal height changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new VirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["Line 0", "Line 1", "Line 2"];
			tui.start();
			await terminal.waitForRender();

			const initialRedraws = tui.fullRedraws;

			// Resize height
			terminal.resize(40, 15);
			await terminal.waitForRender();

			// Should have triggered a full redraw
			assert.ok(tui.fullRedraws > initialRedraws, "Height change should trigger full redraw");

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Line 0"), "Content preserved after height change");

			tui.stop();
		});
	});

	it("skips full re-render on height changes in Termux", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const initialRedraws = tui.fullRedraws;
			for (const height of [15, 8, 14, 11]) {
				terminal.resize(40, height);
				await terminal.waitForRender();
			}

			assert.strictEqual(tui.fullRedraws, initialRedraws, "Height change should not trigger full redraw");
			assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Height change should not clear the screen");
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");

			const viewport = terminal.getViewport();
			assert.ok(viewport.join("\n").includes("Line 19"), "Latest content remains visible after resize");

			tui.stop();
		});
	});

	it("triggers full re-render when terminal width changes", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Resize width
		terminal.resize(60, 10);
		await terminal.waitForRender();

		// Should have triggered a full redraw
		assert.ok(tui.fullRedraws > initialRedraws, "Width change should trigger full redraw");

		tui.stop();
	});
});

describe("flicker budget under streaming", () => {
	test("only one fullRender clear after init", async () => {
		// given
		const metrics = await runStreamingFlickerBudget();

		// when
		logFlickerBudgetMetrics("clear-count", metrics);

		// then
		assert.strictEqual(metrics.clearCount, 1, "Streaming should only emit the initial full clear");
	});

	test("ANSI byte ratio under streaming load", async () => {
		// given
		const metrics = await runStreamingFlickerBudget();

		// when
		logFlickerBudgetMetrics("ansi-ratio", metrics);

		// then
		assert.ok(metrics.ansiByteRatio < 1.5, `ANSI byte ratio should stay below 1.5, got ${metrics.ansiByteRatio}`);
	});

	test("DECSET 2026 begin/end balance", async () => {
		// given
		const metrics = await runStreamingFlickerBudget();

		// when
		logFlickerBudgetMetrics("decset-balance", metrics);

		// then
		assert.strictEqual(metrics.begin2026Count, metrics.end2026Count, "DECSET 2026 begin/end count should match");
	});

	test("zero fullRender(true) invocations after init", async () => {
		// given
		const metrics = await runStreamingFlickerBudget();

		// when
		logFlickerBudgetMetrics("full-render-after-init", metrics);

		// then
		assert.strictEqual(metrics.fullRenderTrueAfterInit, 0, "Streaming should not call fullRender(true) after init");
	});
});

describe("TUI viewport remap for above-viewport growth", () => {
	it("does not clear when expansion starts at viewport top", async () => {
		const terminal = new LoggingVirtualTerminal(72, 6);
		const tui = new TUI(terminal);
		const component = new ExpandableTranscriptComponent();
		tui.addChild(component);

		component.setExpanded(false);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const initialFullRedraws = tui.fullRedraws;

		component.setExpanded(true);
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.strictEqual(tui.fullRedraws, initialFullRedraws, "Viewport-top expansion should stay differential");
		assert.ok(!writes.includes("\x1b[2J"), "Viewport-top expansion should not clear the viewport");
		assert.ok(!writes.includes("\x1b[3J"), "Viewport-top expansion should not clear scrollback");
		assert.ok(
			!writes.includes("\x1b[2J\x1b[H\x1b[3J"),
			"Viewport-top expansion should not clear screen or scrollback",
		);
		assert.strictEqual(
			countOccurrences(writes, "\x1b[?2026h"),
			countOccurrences(writes, "\x1b[?2026l"),
			"Expansion should keep DECSET 2026 begin/end balanced",
		);
		assert.ok(writes.includes("expanded tool detail 15"), "Expanded rows should be repainted into visible viewport");

		const viewport = terminal.getViewport();
		assert.ok(viewport.join("\n").includes("tail row 5"), "Viewport should still show newest tail rows");

		tui.stop();
	});

	it("replays scrollback without viewport clear when collapse changes hidden rows", async () => {
		const terminal = new LoggingVirtualTerminal(72, 6);
		const tui = new TUI(terminal);
		const component = new ExpandableTranscriptComponent();
		tui.addChild(component);

		// given
		component.setExpanded(true);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const initialFullRedraws = tui.fullRedraws;

		// when
		component.setExpanded(false);
		tui.requestRender();
		await terminal.waitForRender();

		// then
		const writes = terminal.getWrites();
		assert.strictEqual(tui.fullRedraws, initialFullRedraws, "Collapse should not full-redraw the viewport");
		assert.ok(!writes.includes("\x1b[2J"), "Collapse should not clear the viewport");
		assert.ok(writes.includes("\x1b[3J"), "Collapse should reset stale scrollback");
		assert.strictEqual(
			countOccurrences(writes, "\x1b[?2026h"),
			countOccurrences(writes, "\x1b[?2026l"),
			"Collapse should keep DECSET 2026 begin/end balanced",
		);
		assert.deepStrictEqual(
			getScrollbackSuffix(terminal.getScrollBuffer(), 8),
			["session title", "tools", "tail row 0", "tail row 1", "tail row 2", "tail row 3", "tail row 4", "tail row 5"],
			"Latest canonical scrollback segment should be collapsed",
		);
		assert.deepStrictEqual(terminal.getViewport(), [
			"tail row 0",
			"tail row 1",
			"tail row 2",
			"tail row 3",
			"tail row 4",
			"tail row 5",
		]);

		tui.stop();
	});

	it("keeps viewport stable across flicker-free Ctrl+O replay toggles", async () => {
		const terminal = new LoggingVirtualTerminal(72, 6);
		const tui = new TUI(terminal);
		const component = new ExpandableTranscriptComponent();
		tui.addChild(component);
		const expectedViewport = ["tail row 0", "tail row 1", "tail row 2", "tail row 3", "tail row 4", "tail row 5"];

		// given
		component.setExpanded(false);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const initialFullRedraws = tui.fullRedraws;

		// when
		for (const expanded of [true, false, true, false, true, false]) {
			component.setExpanded(expanded);
			tui.requestRender();
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport(), expectedViewport);
		}

		// then
		const writes = terminal.getWrites();
		assert.strictEqual(tui.fullRedraws, initialFullRedraws, "Ctrl+O toggles should not full-redraw the viewport");
		assert.ok(!writes.includes("\x1b[2J"), "Ctrl+O toggles should not clear the viewport");
		assert.ok(writes.includes("\x1b[3J"), "Ctrl+O toggles should reset stale scrollback");
		assert.strictEqual(
			countOccurrences(writes, "\x1b[?2026h"),
			countOccurrences(writes, "\x1b[?2026l"),
			"Ctrl+O toggles should keep DECSET 2026 begin/end balanced",
		);

		tui.stop();
	});

	it("does not append duplicate transcript copies during hidden Ctrl+O replay", async () => {
		const terminal = new LoggingVirtualTerminal(72, 6);
		const tui = new TUI(terminal);
		const component = new ExpandableTranscriptComponent();
		tui.addChild(component);
		const expectedViewport = ["tail row 0", "tail row 1", "tail row 2", "tail row 3", "tail row 4", "tail row 5"];

		component.setExpanded(false);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		for (const expanded of [true, false, true, false, true, false]) {
			component.setExpanded(expanded);
			tui.requestRender();
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport(), expectedViewport);
		}

		const writes = terminal.getWrites();
		const scrollback = terminal.getScrollBuffer();
		assert.ok(!writes.includes("\x1b[2J"), "Hidden replay should not clear the visible viewport");
		assert.ok(writes.includes("\x1b[3J"), "Hidden replay should reset stale scrollback before replaying");
		assert.ok(
			scrollback.length <= 24,
			`Hidden replay should keep scrollback bounded to one transcript copy, got ${scrollback.length} rows`,
		);
		assert.deepStrictEqual(
			getScrollbackSuffix(scrollback, 8),
			["session title", "tools", "tail row 0", "tail row 1", "tail row 2", "tail row 3", "tail row 4", "tail row 5"],
			"Latest canonical scrollback segment should match the collapsed transcript",
		);

		tui.stop();
	});

	it("updates scrollback for every offscreen Ctrl+O-expanded block", async () => {
		const terminal = new LoggingVirtualTerminal(72, 5);
		const tui = new TUI(terminal);
		const component = new MultipleExpandableToolTranscriptComponent();
		tui.addChild(component);

		component.setExpanded(false);
		tui.start();
		await terminal.waitForRender();

		assert.ok(
			terminal.getScrollBuffer().includes("read collapsed lib.rs:210-329"),
			"Initial scrollback should contain read block",
		);
		assert.ok(
			terminal.getScrollBuffer().includes("tool collapsed bash output"),
			"Initial scrollback should contain tool block",
		);
		terminal.clearWrites();

		const initialFullRedraws = tui.fullRedraws;

		component.setExpanded(true);
		tui.requestRender();
		await terminal.waitForRender();

		const scrollback = terminal.getScrollBuffer();
		assert.strictEqual(
			tui.fullRedraws,
			initialFullRedraws,
			"Offscreen expansion should not full-redraw the viewport",
		);
		assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Offscreen expansion should not clear the viewport");
		assert.ok(terminal.getWrites().includes("\x1b[3J"), "Offscreen expansion should reset stale scrollback");
		assert.deepStrictEqual(
			getScrollbackSuffix(scrollback, 20),
			[
				"read expanded lib.rs:210",
				"pub until: Option<String>,",
				"pub year: Option<String>,",
				"pub scanner_settings: scanner::ScannerSettings,",
				"pub struct DailyTotals {",
				"pub tokens: i64,",
				"tool expanded bash",
				"stdout line 0",
				"stdout line 1",
				"stdout line 2",
				"stdout line 3",
				"stdout line 4",
				"tail row 0",
				"tail row 1",
				"tail row 2",
				"tail row 3",
				"tail row 4",
				"tail row 5",
				"tail row 6",
				"tail row 7",
			],
			"Latest canonical scrollback segment should include expanded read and tool blocks",
		);
		assert.deepStrictEqual(terminal.getViewport(), [
			"tail row 3",
			"tail row 4",
			"tail row 5",
			"tail row 6",
			"tail row 7",
		]);

		tui.stop();
	});

	it("does not repaint stable tail rows on every expanded streaming append", async () => {
		const terminal = new LoggingVirtualTerminal(72, 6);
		const tui = new TUI(terminal);
		const component = new ExpandedStreamingOutputComponent();
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		for (let index = 0; index < 20; index++) {
			component.appendOutputLine();
			tui.requestRender();
			await terminal.waitForRender();
		}

		const writes = terminal.getWrites();
		const clearLineCount = countOccurrences(writes, "\x1b[2K");
		assert.ok(!writes.includes("\x1b[2J"), "Expanded streaming appends should not clear the viewport");
		assert.ok(!writes.includes("\x1b[3J"), "Expanded streaming appends should not clear scrollback");
		assert.strictEqual(
			countOccurrences(writes, "\x1b[?2026h"),
			countOccurrences(writes, "\x1b[?2026l"),
			"Expanded streaming appends should keep DECSET 2026 begin/end balanced",
		);
		assert.ok(
			clearLineCount <= 25,
			`Expanded streaming appends should draw only new rows, got ${clearLineCount} line clears`,
		);
		assert.deepStrictEqual(terminal.getViewport(), [
			"expanded output 29",
			"expanded output 30",
			"expanded output 31",
			"loader row",
			"editor row",
			"footer row",
		]);

		tui.stop();
	});
});

describe("TUI content shrinkage", () => {
	it("clears empty rows when content shrinks significantly", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		// Start with many lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Shrink to fewer lines
		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		// Should have triggered a full redraw to clear empty rows
		assert.ok(tui.fullRedraws > initialRedraws, "Content shrinkage should trigger full redraw");

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "First line preserved");
		assert.ok(viewport[1]?.includes("Line 1"), "Second line preserved");
		// Lines below should be empty (cleared)
		assert.strictEqual(viewport[2]?.trim(), "", "Line 2 should be cleared");
		assert.strictEqual(viewport[3]?.trim(), "", "Line 3 should be cleared");

		tui.stop();
	});

	it("handles shrink to single line", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to single line
		component.lines = ["Only line"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Only line"), "Single line rendered");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});

	it("handles shrink to empty", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// All lines should be empty
		assert.strictEqual(viewport[0]?.trim(), "", "Line 0 should be cleared");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});
});

describe("TUI differential rendering", () => {
	it("tracks cursor correctly when content shrinks with unchanged remaining lines", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: 5 identical lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to 3 lines, all identical to before (no content changes in remaining lines)
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		// cursorRow should be 2 (last line of new content)
		// Verify by doing another render with a change on line 1
		component.lines = ["Line 0", "CHANGED", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// Line 1 should show "CHANGED", proving cursor tracking was correct
		assert.ok(viewport[1]?.includes("CHANGED"), `Expected "CHANGED" on line 1, got: ${viewport[1]}`);

		tui.stop();
	});

	it("renders correctly when only a middle line changes (spinner case)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render
		component.lines = ["Header", "Working...", "Footer"];
		tui.start();
		await terminal.waitForRender();

		// Simulate spinner animation - only middle line changes
		const spinnerFrames = ["|", "/", "-", "\\"];
		for (const frame of spinnerFrames) {
			component.lines = ["Header", `Working ${frame}`, "Footer"];
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Header"), `Header preserved: ${viewport[0]}`);
			assert.ok(viewport[1]?.includes(`Working ${frame}`), `Spinner updated: ${viewport[1]}`);
			assert.ok(viewport[2]?.includes("Footer"), `Footer preserved: ${viewport[2]}`);
		}

		tui.stop();
	});

	it("resets styles after each rendered line", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["\x1b[3mItalic", "Plain"];
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});

	it("renders correctly when first line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only first line
		component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("CHANGED"), `First line changed: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("Line 3"), `Line 3 preserved: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when last line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only last line
		component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED"), `Last line changed: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when multiple non-adjacent lines change", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Change lines 1 and 3, keep 0, 2, 4 the same
		component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("CHANGED 1"), `Line 1 changed: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED 3"), `Line 3 changed: ${viewport[3]}`);
		assert.ok(viewport[4]?.includes("Line 4"), `Line 4 preserved: ${viewport[4]}`);

		tui.stop();
	});

	it("handles transition from content to empty and back to content", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Start with content
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "Initial content rendered");

		// Clear to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		// Add content back - this should work correctly even after empty state
		component.lines = ["New Line 0", "New Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("New Line 0"), `New content rendered: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("New Line 1"), `New content line 1: ${viewport[1]}`);

		tui.stop();
	});

	it("full re-renders when deleted lines move the viewport upward", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should trigger a full redraw");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);

		tui.stop();
	});

	it("appends after a shrink without another full redraw once the viewport is reset", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should reset the viewport with a full redraw");
		const redrawsAfterShrink = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsAfterShrink, "Append should stay on the differential path");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 0", "Line 1", "Line 2", "", ""]);

		tui.stop();
	});

	it("keeps the viewport anchored when content expands above the visible rows", async () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const stableTail = Array.from({ length: 8 }, (_, i) => `Tail ${i}`);
		component.lines = ["collapsed", ...stableTail];
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["Tail 3", "Tail 4", "Tail 5", "Tail 6", "Tail 7"]);

		const expandedBody = Array.from({ length: 60 }, (_, i) => `Expanded ${i}`);
		component.lines = ["collapsed", ...expandedBody, ...stableTail];
		tui.requestRender();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["Tail 3", "Tail 4", "Tail 5", "Tail 6", "Tail 7"]);

		tui.stop();
	});

	it("clears stale content when maxLinesRendered was inflated by a transient component", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const chat = new TestComponent();
		const editor = new TestComponent();
		tui.addChild(chat);
		tui.addChild(editor);

		const longChat = Array.from({ length: 15 }, (_, i) => `Chat ${i}`);
		const shortChat = Array.from({ length: 12 }, (_, i) => `Chat ${i}`);
		const editorLines = ["Editor 0", "Editor 1", "Editor 2"];
		const selectorLines = Array.from({ length: 8 }, (_, i) => `Selector ${i}`);

		chat.lines = longChat;
		editor.lines = editorLines;
		tui.start();
		await terminal.waitForRender();

		editor.lines = selectorLines;
		tui.requestRender();
		await terminal.waitForRender();

		editor.lines = editorLines;
		tui.requestRender();
		await terminal.waitForRender();

		const redrawsBeforeSwitch = tui.fullRedraws;
		chat.lines = shortChat;
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsBeforeSwitch, "Branch switch should stay on the differential path");

		const viewport = terminal.getViewport();
		for (let i = 0; i < 10; i++) {
			const line = viewport[i] ?? "";
			assert.ok(!line.includes("Chat 12"), `Stale "Chat 12" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 13"), `Stale "Chat 13" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 14"), `Stale "Chat 14" at viewport row ${i}`);
		}

		assert.deepStrictEqual(viewport, [
			"Chat 5",
			"Chat 6",
			"Chat 7",
			"Chat 8",
			"Chat 9",
			"Chat 10",
			"Chat 11",
			"Editor 0",
			"Editor 1",
			"Editor 2",
		]);

		tui.stop();
	});
});
