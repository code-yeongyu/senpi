import { describe, expect, it } from "vitest";
import { renderEvalCall } from "../src/tool/render.ts";
import { callContext, renderLines } from "./eval-render-fixtures.ts";

// 80 words: wraps to more than three visual lines at the fixture width of 80 columns.
const LONG_SUMMARY = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
const ELLIPSIS = "\u2026";

function callArgs(summary: string): Parameters<typeof renderEvalCall>[0] {
	return { language: "js", code: "return 1", summary };
}

function summaryLinesOf(lines: readonly string[], prefix: string): string[] {
	// Line 0 is the title/header; summary lines follow until the code line.
	const codeIndex = lines.findIndex((line, index) => index > 0 && line.includes("return 1"));
	return lines.slice(1, codeIndex).map((line) => line.slice(prefix.length));
}

describe("eval summary display", () => {
	it("shows the first three lines of a long summary and marks the cut when collapsed", () => {
		// Given (senpi#2050: summaries have no length limit, so the collapsed block bounds them)
		const component = renderEvalCall(callArgs(LONG_SUMMARY), undefined, callContext());

		// When
		const summaryLines = summaryLinesOf(renderLines(component), "");

		// Then
		expect(summaryLines).toHaveLength(3);
		expect(summaryLines.at(-1)?.endsWith(ELLIPSIS)).toBe(true);
		expect(LONG_SUMMARY.startsWith(summaryLines.join(" ").slice(0, -ELLIPSIS.length))).toBe(true);
		for (const line of summaryLines) expect(line.length).toBeLessThanOrEqual(80);
	});

	it("shows the whole summary when expanded", () => {
		// Given
		const component = renderEvalCall(callArgs(LONG_SUMMARY), undefined, callContext({ expanded: true }));

		// When
		const summaryLines = summaryLinesOf(renderLines(component), "");

		// Then
		expect(summaryLines.join(" ")).toBe(LONG_SUMMARY);
	});

	it("bounds the summary inside the live cell frame too", () => {
		// Given
		const component = renderEvalCall(callArgs(LONG_SUMMARY), undefined, callContext({ spinnerFrame: 0 }));

		// When
		const summaryLines = summaryLinesOf(renderLines(component), "\u2502 ");

		// Then
		expect(summaryLines).toHaveLength(3);
		expect(summaryLines.at(-1)?.endsWith(ELLIPSIS)).toBe(true);
	});

	it("renders a short summary unchanged on one line", () => {
		// Given
		const summary = "Working on the render fixture to check the summary line";

		// When
		const component = renderEvalCall(callArgs(summary), undefined, callContext());

		// Then
		expect(summaryLinesOf(renderLines(component), "")).toEqual([summary]);
	});
});
