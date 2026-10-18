import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/index.ts";
import { frameLineBytesTotals, TUI } from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// senpi#1960 todo 2: the frame-level figure - the byte cost of the lines the last frame holds -
// reported alongside the render cache so the memory report can attribute a long session's growth.

class LinesComponent implements Component {
	readonly #output: readonly string[];
	constructor(output: readonly string[]) {
		this.#output = output;
	}
	render(_width: number): string[] {
		return [...this.#output];
	}
	invalidate(): void {}
}

describe("frame line byte totals (#1960)", () => {
	it("is zero before any frame renders", () => {
		assert.equal(frameLineBytesTotals().previousLinesBytes, 0);
	});

	it("reports the committed frame's line bytes after a render and releases them on stop", async () => {
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TUI(terminal);
		const frame = ["alpha line", "beta"];
		tui.addChild(new LinesComponent(frame));
		const before = frameLineBytesTotals().previousLinesBytes;
		tui.start();

		// The signal is the render itself: subscribe to it before triggering, then await it bounded.
		const settled = terminal.waitForRender();
		tui.requestRender();
		await settled;

		// What the TUI commits per frame (tui.ts setPreviousLines): each text line normalized with the
		// segment-reset suffix, then the estimator - an 8-byte slot per line plus 2 per code unit.
		const SEGMENT_RESET_SUFFIX = "\x1b[0m\x1b]8;;\x07";
		const committed = frame.map((line) => line + SEGMENT_RESET_SUFFIX);
		const committedBytes = committed.length * 8 + committed.join("").length * 2;
		const rendered = frameLineBytesTotals().previousLinesBytes;
		assert.equal(
			rendered,
			before + committedBytes,
			`committed frame cost: ${before} + ${committedBytes} (got ${rendered})`,
		);

		tui.stop();
		assert.equal(
			frameLineBytesTotals().previousLinesBytes,
			before,
			"stopping the TUI releases its frame from the process total",
		);
	});
});
