import { Theme, type ThemeColor } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { renderEvalResult } from "../src/tool/render.ts";
import { evalResult, resultContext } from "./eval-render-fixtures.ts";

const FG_COLORS = {
	accent: "#010101",
	border: "#020202",
	borderAccent: "#030303",
	borderMuted: "#040404",
	success: "#050505",
	error: "#060606",
	warning: "#070707",
	muted: "#080808",
	dim: "#090909",
	text: "#0a0a0a",
	thinkingText: "#0b0b0b",
	userMessageText: "#0c0c0c",
	customMessageText: "#0d0d0d",
	customMessageLabel: "#0e0e0e",
	toolTitle: "#0f0f0f",
	toolOutput: "#101010",
	mdHeading: "#111111",
	mdLink: "#121212",
	mdLinkUrl: "#131313",
	mdCode: "#141414",
	mdCodeBlock: "#151515",
	mdCodeBlockBorder: "#161616",
	mdQuote: "#171717",
	mdQuoteBorder: "#181818",
	mdHr: "#191919",
	mdListBullet: "#1a1a1a",
	toolDiffAdded: "#1b1b1b",
	toolDiffRemoved: "#1c1c1c",
	toolDiffContext: "#1d1d1d",
	syntaxComment: "#1e1e1e",
	syntaxKeyword: "#1f1f1f",
	syntaxFunction: "#202020",
	syntaxVariable: "#212121",
	syntaxString: "#222222",
	syntaxNumber: "#232323",
	syntaxType: "#242424",
	syntaxOperator: "#252525",
	syntaxPunctuation: "#262626",
	thinkingOff: "#272727",
	thinkingMinimal: "#282828",
	thinkingLow: "#292929",
	thinkingMedium: "#2a2a2a",
	thinkingHigh: "#2b2b2b",
	thinkingXhigh: "#2c2c2c",
	thinkingMax: "#2d2d2d",
	bashMode: "#2e2e2e",
} satisfies Record<ThemeColor, string>;

const BG_COLORS = {
	selectedBg: "#303030",
	userMessageBg: "#313131",
	customMessageBg: "#323232",
	toolPendingBg: "#333333",
	toolSuccessBg: "#343434",
	toolErrorBg: "#353535",
};

const TEST_THEME = new Theme(FG_COLORS, BG_COLORS, "truecolor", { name: "eval-render-theme-test" });

function requiredLine(lines: readonly string[], text: string): string {
	const line = lines.find((item) => item.includes(text));
	if (line === undefined) throw new Error(`Missing rendered line containing ${JSON.stringify(text)}`);
	return line;
}

function expectStartsWithColor(line: string, color: ThemeColor): void {
	expect(line.startsWith(TEST_THEME.getFgAnsi(color))).toBe(true);
}

describe("eval renderer theme hierarchy", () => {
	it("Given running done and error results when themed then status headers use distinct semantic colors", () => {
		// Given
		const runningResult = evalResult({ language: "py", durationMs: 0, toolCalls: [], truncated: false }, "partial");
		const doneResult = evalResult({ language: "py", durationMs: 5, toolCalls: [], truncated: false }, "ok");
		const errorResult = evalResult(
			{ language: "py", durationMs: 5, toolCalls: [], truncated: false, isError: true },
			"boom",
		);

		// When
		const runningHeader = renderEvalResult(
			runningResult,
			{ expanded: false, isPartial: true },
			TEST_THEME,
			resultContext(),
		).render(80)[0];
		const doneHeader = renderEvalResult(
			doneResult,
			{ expanded: false, isPartial: false },
			TEST_THEME,
			resultContext(),
		).render(80)[0];
		const errorHeader = renderEvalResult(
			errorResult,
			{ expanded: false, isPartial: false },
			TEST_THEME,
			resultContext(),
		).render(80)[0];

		// Then
		expectStartsWithColor(requiredLine([runningHeader ?? ""], "running"), "warning");
		expectStartsWithColor(requiredLine([doneHeader ?? ""], "done"), "success");
		expectStartsWithColor(requiredLine([errorHeader ?? ""], "error"), "error");
		expect((runningHeader ?? "").startsWith(TEST_THEME.getFgAnsi("success"))).toBe(false);
		expect((doneHeader ?? "").startsWith(TEST_THEME.getFgAnsi("warning"))).toBe(false);
	});

	it("Given successful and failed nested tool calls when themed then rows are visibly differentiated", () => {
		// Given
		const result = evalResult(
			{
				language: "js",
				durationMs: 1,
				toolCalls: [
					{ name: "search", ok: true },
					{ name: "write", ok: false, error: "denied" },
				],
				truncated: false,
			},
			"complete",
		);

		// When
		const lines = renderEvalResult(result, { expanded: false, isPartial: false }, TEST_THEME, resultContext()).render(
			80,
		);
		const successLine = requiredLine(lines, "tool.search");
		const failedLine = requiredLine(lines, "tool.write");

		// Then
		expectStartsWithColor(successLine, "success");
		expectStartsWithColor(failedLine, "error");
		expect(successLine.slice(0, TEST_THEME.getFgAnsi("success").length)).not.toBe(
			failedLine.slice(0, TEST_THEME.getFgAnsi("success").length),
		);
	});
});
