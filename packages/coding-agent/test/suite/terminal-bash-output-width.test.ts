import { Box, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { renderBashOutputResult } from "../../src/core/extensions/builtin/terminal/tools/render.ts";
import type { ToolRenderContext, ToolRenderResultOptions } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

type BashOutputResult = Parameters<typeof renderBashOutputResult>[0];

const BOX_WIDTH = 98;
const LINE_102 = "c".repeat(102);
const LINE_180 = "p".repeat(180);
const LONG_PATH =
	"make[1]: Entering directory '/workspace/project/models/share/Library/src/vendor/third_party/fortran/modules'";
const LONG_COMMAND =
	"nvfortran -module /workspace/project/models/share/include -c -Mpreprocess -r8 -O3 -Munroll=c:1 -Mlre -Mvect=simd -Mcache_align -r8 ModHdf5Utils.f90";
const ANSI_LONG_LINE = `\x1b[31m${LONG_PATH}\x1b[39m`;
const WIDE_UNICODE_LINE = `wide ${"全".repeat(60)} end`;

function bashOutputText(): string {
	return [
		"status: exited_2 exit_code: 2",
		LONG_PATH,
		LONG_COMMAND,
		LINE_102,
		LINE_180,
		ANSI_LONG_LINE,
		WIDE_UNICODE_LINE,
	].join("\n");
}

function renderContext(options: ToolRenderResultOptions): ToolRenderContext {
	return {
		args: { bash_id: "bash_1" },
		toolCallId: "bash-output-width",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: "/tmp/workspace",
		executionStarted: true,
		argsComplete: true,
		isPartial: options.isPartial,
		expanded: options.expanded,
		showImages: false,
		isError: false,
	};
}

function createResult(options: ToolRenderResultOptions, text = bashOutputText()) {
	const result: BashOutputResult = { content: [{ type: "text", text }], details: undefined };
	return renderBashOutputResult(result, options, theme, renderContext(options));
}

function renderBox(width: number, options: ToolRenderResultOptions, text = bashOutputText()): string[] {
	const box = new Box(1, 1, (value: string) => `\x1b[48;5;22m${value}\x1b[49m`);
	box.addChild(createResult(options, text));
	return box.render(width);
}

function nonWhitespaceCodepoints(text: string): string {
	return [...text].filter((ch) => !/\s/u.test(ch)).join("");
}

function expectLinesFit(lines: string[], width: number): void {
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

function expectPreserved(lines: string[], original: string): void {
	expect(nonWhitespaceCodepoints(lines.map(stripTerminalSequences).join(""))).toBe(
		nonWhitespaceCodepoints(stripTerminalSequences(original)),
	);
}

describe("bash_output completed/expanded width wrap", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("fits a 98-column Box for complete output with ANSI, CJK, and long command/path lines", () => {
		expect(visibleWidth(LINE_102)).toBeGreaterThan(BOX_WIDTH - 2);
		expect(visibleWidth(LINE_180)).toBeGreaterThan(BOX_WIDTH - 2);
		expect(visibleWidth(LONG_PATH)).toBeGreaterThan(BOX_WIDTH - 2);
		expect(visibleWidth(LONG_COMMAND)).toBeGreaterThan(BOX_WIDTH - 2);
		expect(visibleWidth(WIDE_UNICODE_LINE)).toBeGreaterThan(BOX_WIDTH - 2);

		const text = bashOutputText();
		const lines = renderBox(BOX_WIDTH, { expanded: false, isPartial: false }, text);
		expect(lines.length).toBeGreaterThan(0);
		expectLinesFit(lines, BOX_WIDTH);
		expectPreserved(lines, text);
		expect(lines.join("")).toContain("\x1b[31m");
	});

	it("fits a 98-column Box for expanded partial output", () => {
		const text = bashOutputText();
		const lines = renderBox(BOX_WIDTH, { expanded: true, isPartial: true }, text);
		expectLinesFit(lines, BOX_WIDTH);
		expectPreserved(lines, text);
	});

	it("wraps complete component output across resize widths without dropping tokens", () => {
		const text = bashOutputText();
		const component = createResult({ expanded: false, isPartial: false }, text);
		for (const width of [24, 40, 80, BOX_WIDTH, 160]) {
			const lines = component.render(width);
			expectLinesFit(lines, width);
			expectPreserved(lines, text);
			expect(lines.join("")).toContain("\x1b[31m");
		}
	});

	it("wraps expanded ANSI and CJK lines without dropping tokens", () => {
		const text = bashOutputText();
		const component = createResult({ expanded: true, isPartial: true }, text);
		for (const width of [20, 41, 97, 98]) {
			const lines = component.render(width);
			expectLinesFit(lines, width);
			expectPreserved(lines, text);
			const payload = lines.join("");
			expect(payload).toContain("\x1b[31m");
			expect(payload).toContain("全");
		}
	});

	it("keeps partial preview truncated while preserving remaining non-whitespace characters", () => {
		const text = Array.from(
			{ length: 40 },
			(_, index) => `preview-line-${String(index).padStart(2, "0")}-${"x".repeat(30)}`,
		).join("\n");
		const preview = createResult({ expanded: false, isPartial: true }, text).render(40);
		const expanded = createResult({ expanded: true, isPartial: true }, text).render(40);
		expectLinesFit(preview, 40);
		expectLinesFit(expanded, 40);
		expect(preview.length).toBeLessThan(expanded.length);
		const previewChars = nonWhitespaceCodepoints(preview.map(stripTerminalSequences).join(""));
		const originalChars = nonWhitespaceCodepoints(stripTerminalSequences(text));
		expect(originalChars.endsWith(previewChars)).toBe(true);
		expect(previewChars.length).toBeGreaterThan(0);
		expectPreserved(expanded, text);
	});
});
