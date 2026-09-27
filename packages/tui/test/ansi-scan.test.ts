import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getActiveBackgroundAnsi, stripTerminalSequences, visibleWidth } from "../src/utils.ts";

describe("terminal sequence scanning", () => {
	it("preserves malformed escapes while still stripping later recognized sequences", () => {
		const cases: [string, string][] = [
			["plain text", "plain text"],
			["before\x1b", "before\x1b"],
			["a\x1b[unfinished", "a\x1b[unfinished"],
			["a\x1b?x\x1b[31mb", "a\x1b?xb"],
			["a\x1b]open\x1b[31mb", "a\x1b]openb"],
			["a\x1b[bad\x1b[31mb", "ab"],
			["a\x1b]0;x\t\x1b[31m\x07b\tc", "ab\tc"],
			["a\x1b_payload\x1b\\b", "ab"],
			["a\x1bPtmux;\x1b\x1b]x\x1b\x1b\\y\x1b\\b", "ab"],
		];
		for (const [text, expected] of cases) {
			assert.equal(stripTerminalSequences(text), expected);
		}
	});

	it("measures Unicode clusters across removed sequences and normalizes visible tabs", () => {
		assert.equal(visibleWidth("e\x1b[31m\u0301"), 1);
		assert.equal(visibleWidth("👨\x1b[31m‍💻"), 2);
		assert.equal(visibleWidth("\x1b]8;;https://example.test/a\tb\x07x\ty\x1b]8;;\x07"), 5);
	});

	it("tracks styling after malformed escapes without reading styling inside valid string sequences", () => {
		assert.equal(getActiveBackgroundAnsi("before\x1b?X\x1b[44mafter"), "\x1b[44m");
		assert.equal(getActiveBackgroundAnsi("\x1b[44mx\x1b]0;\x1b[41m\x07tail"), "\x1b[44m");
		assert.equal(getActiveBackgroundAnsi("\x1b[44mx\x1b_payload\x1b[41m\x1b\\tail"), "\x1b[44m");
		assert.equal(getActiveBackgroundAnsi("\x1b[44mx\x1b[0mtail"), "");
	});
});
