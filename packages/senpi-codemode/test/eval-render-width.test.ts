import type { AgentToolResult } from "@code-yeongyu/senpi";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { callContext, evalResult, evalResultWithOmittedDetails, resultContext } from "./eval-render-fixtures.ts";

const WIDTHS = [40, 80, 120] as const;

function expectLinesWithinWidth(lines: readonly string[], width: number, label: string): void {
	for (const [index, line] of lines.entries()) {
		expect(visibleWidth(line), `${label} line ${index}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
	}
}

function longWord(label: string): string {
	return `${label}-${"supercalifragilisticexpialidocious".repeat(4)}`;
}

describe.each(WIDTHS)("eval renderer width %i", (width) => {
	it("Given wide output title emoji ANSI and long words when rendered then every line fits", () => {
		// Given
		const givenCall = renderEvalCall(
			{
				language: "py",
				title: "analysis🙂",
				code: [
					"print('hello🙂')",
					longWord("call"),
					"for i in range(2):",
					"    print(i)",
					"print('last line')",
				].join("\n"),
			},
			undefined,
			callContext(),
		);
		const givenResult = evalResult(
			{
				language: "py",
				title: "analysis🙂",
				durationMs: 12,
				toolCalls: [{ name: "searchTool", ok: true }],
				truncated: false,
			},
			["\x1b[31mred output🙂\x1b[0m", "korean result with emoji 🚀", longWord("output")].join("\n"),
		);

		// When
		const lines = [
			...givenCall.render(width),
			...renderEvalResult(givenResult, { expanded: false, isPartial: false }, undefined, resultContext()).render(
				width,
			),
		];

		// Then
		expectLinesWithinWidth(lines, width, "wide ansi emoji");
		expect(lines.join("\n")).toContain("\x1b[31m");
	});

	it("Given missing details and image-only content when rendered then fallback lines fit", () => {
		// Given
		const missingDetails = evalResultWithOmittedDetails("");
		const imageOnly = {
			content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
			details: {
				language: "js",
				durationMs: 1,
				toolCalls: [],
				truncated: false,
			},
		} satisfies AgentToolResult<EvalToolDetails>;

		// When
		const lines = [
			...renderEvalResult(missingDetails, { expanded: false, isPartial: false }, undefined, resultContext()).render(
				width,
			),
			...renderEvalResult(
				imageOnly,
				{ expanded: false, isPartial: false },
				undefined,
				resultContext({ showImages: false }),
			).render(width),
			...renderEvalResult(
				imageOnly,
				{ expanded: false, isPartial: false },
				undefined,
				resultContext({ showImages: true }),
			).render(width),
		];

		// Then
		expectLinesWithinWidth(lines, width, "fallback image");
		expect(lines).toContain("(no output)");
		expect(lines).toContain("[image: image/png]");
	});

	it("Given long failed nested tool call when rendered then wrapped tool rows fit", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "js",
				durationMs: 9,
				toolCalls: [
					{ name: "short", ok: true },
					{ name: "very_long_nested_tool_name_for_width_regression", ok: false, error: longWord("denied") },
				],
				truncated: false,
			},
			"complete",
		);

		// When
		const lines = renderEvalResult(
			givenResult,
			{ expanded: true, isPartial: false },
			undefined,
			resultContext(),
		).render(width);

		// Then
		expectLinesWithinWidth(lines, width, "nested tool");
		expect(lines.join("\n")).toContain("very_long_nested_tool_name");
		expect(lines.join("\n")).toContain("denied");
	});

	it("Given truncated multiline output when collapsed then preview hiding fits and hides early lines", () => {
		// Given
		const outputLines = Array.from({ length: 12 }, (_, index) => `hidden-output-${index + 1}-${longWord("chunk")}`);
		const givenResult = evalResult(
			{ language: "jl", durationMs: 3, toolCalls: [], truncated: true },
			outputLines.join("\n"),
		);

		// When
		const lines = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(),
		).render(width);
		const visibleText = lines.join("\n");

		// Then
		expectLinesWithinWidth(lines, width, "truncated preview");
		expect(visibleText).toContain("earlier output lines");
		expect(visibleText).toContain("[eval output truncated]");
		expect(visibleText).not.toContain(outputLines[0]);
	});
});

describe("eval renderer rerender width behavior", () => {
	it("Given same result instance when resized then every resized line fits", () => {
		// Given
		const component = renderEvalResult(
			evalResult(
				{ language: "rb", title: "resize🙂", durationMs: 4, toolCalls: [], truncated: false },
				[longWord("wide"), "second line", "third line🙂"].join("\n"),
			),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(),
		);

		// When
		const wide = component.render(120);
		const narrow = component.render(40);

		// Then
		expectLinesWithinWidth(wide, 120, "wide same instance");
		expectLinesWithinWidth(narrow, 40, "narrow same instance");
	});

	it("Given collapsed component when rerendered expanded then hidden preview content returns and fits", () => {
		// Given
		const codeLines = Array.from({ length: 7 }, (_, index) => `code-${index + 1}-${longWord("cell")}`);
		const args = { language: "js", code: codeLines.join("\n") } satisfies Parameters<typeof renderEvalCall>[0];
		const collapsed = renderEvalCall(args, undefined, callContext());

		// When
		const expanded = renderEvalCall(args, undefined, callContext({ lastComponent: collapsed, expanded: true }));
		const lines = expanded.render(40);
		const text = lines.join("\n");

		// Then
		expect(expanded).toBe(collapsed);
		expectLinesWithinWidth(lines, 40, "expanded call");
		expect(text).toContain("code-1-cell");
		expect(text).toContain("code-7-cell");
		expect(text).not.toContain("earlier code lines");
	});
});

describe("eval renderer cell detail width", () => {
	it("Given narrow CJK cell status agent JSON and truncation details when rendered then every line reflows within width", () => {
		// Given
		const width = 40;
		const givenResult = evalResult(
			{
				language: "py",
				durationMs: 900,
				toolCalls: [],
				truncated: true,
				isError: true,
				cells: [
					{
						index: 0,
						title: "failed cell",
						code: "print('korean-output-test')",
						language: "py",
						output: "korean-output-test and this very long error description must wrap to fit the width",
						status: "error",
						durationMs: 900,
						statusEvents: [
							{ op: "read", path: "/tmp/settings.json", chars: 12 },
							{ op: "write", path: "/tmp/result.json", chars: 8 },
							{ op: "agent", id: "worker-cell", status: "completed", durationMs: 700 },
						],
					},
				],
				jsonOutputs: [{ a: 1 }],
				meta: {
					direction: "tail",
					truncatedBy: "lines",
					totalLines: 12,
					totalBytes: 240,
					outputLines: 3,
					outputBytes: 60,
					shownRange: { start: 10, end: 12 },
					artifactId: "/tmp/full-output.log",
				},
			},
			"",
		);

		// When
		const lines = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(),
		).render(width);
		const text = lines.join("\n");

		// Then
		expectLinesWithinWidth(lines, width, "narrow detail render");
		expect.soft(text).toContain("eval py failed cell error");
		expect.soft(text).toContain("read 12 chars");
		expect.soft(text).toContain("worker-cell done");
		expect.soft(text).toContain("display[1]");
		expect.soft(text).toContain("Showing lines 10-12 of 12");
	});
});
