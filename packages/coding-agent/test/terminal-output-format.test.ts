import { describe, expect, it } from "vitest";
import {
	formatTerminalToolOutput,
	sanitizeTerminalOutput,
	TERMINAL_TOOL_MAX_BYTES,
	TERMINAL_TOOL_MAX_LINES,
} from "../src/core/extensions/builtin/terminal/output-format.ts";

/**
 * The PTY-backed bash tools return raw terminal streams. Before the output
 * reaches the model it must be (a) stripped of escape/control sequences and
 * carriage-return redraw frames, and (b) bounded to the same budget the core
 * bash tool enforces — a single `gh run view --log-failed` used to inject
 * ~1 MB of raw ANSI soup into the context and force emergency compactions.
 */

describe("sanitizeTerminalOutput", () => {
	it("passes plain text through unchanged", () => {
		expect(sanitizeTerminalOutput("hello world\nsecond line")).toBe("hello world\nsecond line");
	});

	it("strips CSI color and cursor sequences", () => {
		expect(sanitizeTerminalOutput("\x1b[1m\x1b[31mred bold\x1b[0m plain")).toBe("red bold plain");
		expect(sanitizeTerminalOutput("\x1b[2m$\x1b[0m \x1b[1mls\x1b[0m")).toBe("$ ls");
	});

	it("strips private mode and keypad escapes", () => {
		expect(sanitizeTerminalOutput("\x1b[?1h\x1b=\r\nok\x1b[?1l\x1b>")).toBe("\nok");
	});

	it("strips OSC hyperlinks and title sequences", () => {
		expect(sanitizeTerminalOutput("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
		expect(sanitizeTerminalOutput("\x1b]11;?\x1b\\done")).toBe("done");
	});

	it("normalizes CRLF newlines to LF", () => {
		expect(sanitizeTerminalOutput("one\r\ntwo\r\nthree")).toBe("one\ntwo\nthree");
	});

	it("collapses carriage-return spinner frames to the final frame", () => {
		const spinner = "\r\x1b[K\x1b[36m⣾\x1b[0m\r\x1b[K\x1b[36m⣽\x1b[0m\r\x1b[K\x1b[36m⣻\x1b[0m done";
		expect(sanitizeTerminalOutput(spinner)).toBe("⣻ done");
	});

	it("keeps the tail of a longer line when a shorter redraw overwrites it", () => {
		expect(sanitizeTerminalOutput("abcdef\rXY")).toBe("XYcdef");
	});

	it("applies carriage returns per line independently", () => {
		expect(sanitizeTerminalOutput("first-aaa\rfirst-b\nsecond-ccc\rsecond-d")).toBe("first-baa\nsecond-dcc");
	});

	it("handles backspace overwrites", () => {
		expect(sanitizeTerminalOutput("abc\x08\x08XY")).toBe("aXY");
	});

	it("strips remaining C0 control characters but keeps tabs", () => {
		expect(sanitizeTerminalOutput("a\x00b\x07c\td")).toBe("abc\td");
	});
});

describe("formatTerminalToolOutput", () => {
	it("returns sanitized output untouched when within budget", () => {
		const result = formatTerminalToolOutput("\x1b[32mok\x1b[0m\n");
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("ok");
	});

	it("keeps the tail of over-line-budget output with a marker", () => {
		const lines = Array.from({ length: TERMINAL_TOOL_MAX_LINES + 500 }, (_, i) => `line-${i}`);
		const result = formatTerminalToolOutput(lines.join("\n"));
		expect(result.truncated).toBe(true);
		expect(result.text).toContain(`line-${TERMINAL_TOOL_MAX_LINES + 499}`);
		expect(result.text).not.toContain("line-0");
		expect(result.text).toContain("Showing lines");
		expect(result.text).toContain("earlier output dropped");
	});

	it("keeps over-byte-budget output within the byte limit", () => {
		const result = formatTerminalToolOutput("x".repeat(TERMINAL_TOOL_MAX_BYTES * 4));
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(TERMINAL_TOOL_MAX_BYTES + 512);
	});

	it("sanitizes before truncating so escape bytes cannot starve the budget", () => {
		// 60k chars of spinner frames must collapse to nearly nothing rather than
		// filling the byte budget with redraw garbage.
		const frame = "\r\x1b[K\x1b[36m⣾\x1b[0m";
		const result = formatTerminalToolOutput(`${frame.repeat(3000)}\r\x1b[K\x1b[32m✓\x1b[0m finished`);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("✓ finished");
	});
});
