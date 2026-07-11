import { describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import { callContext, evalResult, renderLines, resultContext } from "./eval-render-fixtures.ts";

describe("eval renderer preview", () => {
	it("Given six code lines when collapsed then last four and earlier code count are shown", () => {
		// Given
		const codeLines = ["code-line-1", "code-line-2", "code-line-3", "code-line-4", "code-line-5", "code-line-6"];
		const givenArgs = {
			language: "js",
			code: codeLines.join("\n"),
		} satisfies Parameters<typeof renderEvalCall>[0];

		// When
		const component = renderEvalCall(givenArgs, undefined, callContext());

		// Then
		const lines = renderLines(component);
		for (const visibleLine of codeLines.slice(-4)) expect.soft(lines).toContain(visibleLine);
		for (const hiddenLine of codeLines.slice(0, 2)) expect.soft(lines).not.toContain(hiddenLine);
		expect.soft(lines).toContain("2 earlier code lines");
	});

	it("Given ten output lines when collapsed then last eight and earlier output count are shown", () => {
		// Given
		const outputLines = Array.from({ length: 10 }, (_, index) => `output-line-${index + 1}`);
		const givenResult = evalResult(
			{ language: "js", durationMs: 1, toolCalls: [], truncated: false },
			outputLines.join("\n"),
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		const lines = renderLines(component);
		for (const visibleLine of outputLines.slice(-8)) expect.soft(lines).toContain(visibleLine);
		for (const hiddenLine of outputLines.slice(0, 2)) expect.soft(lines).not.toContain(hiddenLine);
		expect.soft(lines).toContain("2 earlier output lines");
	});

	it("Given seven nested tool calls when collapsed then last five and earlier tool count are shown", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "js",
				durationMs: 1,
				toolCalls: [
					{ name: "call-1", ok: true },
					{ name: "call-2", ok: false, error: "early denied" },
					{ name: "call-3", ok: true },
					{ name: "call-4", ok: false, error: "late denied" },
					{ name: "call-5", ok: true },
					{ name: "call-6", ok: true },
					{ name: "call-7", ok: true },
				],
				truncated: false,
			},
			"complete",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		const lines = renderLines(component);
		const toolLines = lines.filter((line) => line.includes("tool."));
		expect.soft(toolLines).not.toContain("- tool.call-1: ok");
		expect.soft(toolLines).not.toContain("- tool.call-2: error (early denied)");
		expect.soft(toolLines).toContain("- tool.call-3: ok");
		expect.soft(toolLines).toContain("- tool.call-4: error (late denied)");
		expect.soft(toolLines).toContain("- tool.call-5: ok");
		expect.soft(toolLines).toContain("- tool.call-6: ok");
		expect.soft(toolLines).toContain("- tool.call-7: ok");
		expect.soft(lines).toContain("2 earlier tool calls");
	});

	it("Given six nested tool calls when collapsed then singular earlier tool count is shown", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "js",
				durationMs: 1,
				toolCalls: Array.from({ length: 6 }, (_, index) => ({ name: `call-${index + 1}`, ok: true })),
				truncated: false,
			},
			"complete",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component)).toContain("1 earlier tool call");
	});

	it("Given truncated details when rendered then eval output truncated marker is shown", () => {
		// Given
		const outputLines = Array.from({ length: 10 }, (_, index) => `truncated-line-${index + 1}`);
		const givenResult = evalResult(
			{ language: "js", durationMs: 1, toolCalls: [], truncated: true },
			outputLines.join("\n"),
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		const lines = renderLines(component);
		const outputCollapseLines = lines.filter((line) => line.includes("earlier") && line.includes("output"));
		expect.soft(lines).toContain("[eval output truncated]");
		expect.soft(outputCollapseLines).toEqual(["2 earlier output lines"]);
	});

	it("Given reused completed eval render when expanded then all code output and nested tool calls are visible", () => {
		// Given
		const codeLines = Array.from({ length: 6 }, (_, index) => `expanded-code-line-${index + 1}`);
		const outputLines = Array.from({ length: 10 }, (_, index) => `expanded-output-line-${index + 1}`);
		const toolCalls = Array.from({ length: 7 }, (_, index) => ({
			name: `expanded-call-${index + 1}`,
			ok: true,
		}));
		const givenArgs = {
			language: "js",
			code: codeLines.join("\n"),
		} satisfies Parameters<typeof renderEvalCall>[0];
		const givenResult = evalResult(
			{ language: "js", durationMs: 1, toolCalls, truncated: false },
			outputLines.join("\n"),
		);
		const collapsedCall = renderEvalCall(givenArgs, undefined, callContext());
		const collapsedResult = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// When
		const expandedCall = renderEvalCall(
			givenArgs,
			undefined,
			callContext({ lastComponent: collapsedCall, expanded: true }),
		);
		const expandedResult = renderEvalResult(
			givenResult,
			{ expanded: true, isPartial: false },
			undefined,
			resultContext({ lastComponent: collapsedResult, expanded: true }),
		);

		// Then
		const lines = [...renderLines(expandedCall), ...renderLines(expandedResult)];
		const visibleText = lines.join("\n");
		expect.soft(expandedCall).toBe(collapsedCall);
		expect.soft(expandedResult).toBe(collapsedResult);
		for (const codeLine of codeLines) expect.soft(lines).toContain(codeLine);
		for (const outputLine of outputLines) expect.soft(lines).toContain(outputLine);
		for (const toolCall of toolCalls) expect.soft(lines).toContain(`- tool.${toolCall.name}: ok`);
		expect.soft(visibleText).not.toMatch(/\bearlier\b/i);
		expect.soft(visibleText).not.toMatch(/ctrl|to expand|to collapse/i);
	});

	it("Given realistically large expanded code when rendered then every line remains visible", () => {
		// Given
		const codeLines = Array.from({ length: 4_096 }, (_, index) => `expanded-line-${index + 1}`);
		const givenArgs = {
			language: "js",
			code: codeLines.join("\n"),
		} satisfies Parameters<typeof renderEvalCall>[0];

		// When
		const lines = renderEvalCall(givenArgs, undefined, callContext({ expanded: true })).render(80);

		// Then
		expect.soft(lines).toHaveLength(codeLines.length + 1);
		expect.soft(lines[1]).toBe(codeLines[0]);
		expect.soft(lines.at(-1)).toBe(codeLines.at(-1));
	});

	it("Given a retained nested tool call with a huge multiline error when collapsed then detail is bounded and expandable", () => {
		// Given
		const errorLines = [
			"first-error-line",
			...Array.from({ length: 2_048 }, (_, index) => `error-detail-${index + 1}-${"x".repeat(32)}`),
			"last-error-line",
		];
		const givenResult = evalResult(
			{
				language: "js",
				durationMs: 1,
				toolCalls: [{ name: "massive", ok: false, error: errorLines.join("\n") }],
				truncated: false,
			},
			"complete",
		);

		// When
		const collapsedLines = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		).render(80);
		const expandedLines = renderEvalResult(
			givenResult,
			{ expanded: true, isPartial: false },
			undefined,
			resultContext({ expanded: true }),
		).render(80);

		// Then
		const collapsedToolStart = collapsedLines.findIndex((line) => line.includes("tool.massive"));
		const collapsedToolLines = collapsedLines.slice(collapsedToolStart);
		const collapsedText = collapsedToolLines.join("\n");
		const expandedText = expandedLines.join("\n");
		expect(collapsedToolStart).toBeGreaterThanOrEqual(0);
		expect(collapsedToolLines.length).toBeLessThanOrEqual(4);
		expect(collapsedText).toContain("tool.massive");
		expect(collapsedText).toContain("error");
		expect(collapsedText).toContain("[tool error omitted]");
		expect(collapsedText).not.toContain("last-error-line");
		expect(expandedText).toContain("tool.massive");
		expect(expandedText).toContain("last-error-line");
		expect(expandedText).not.toContain("[tool error omitted]");
	});

	it("Given an emoji across the old UTF-16 error boundary when collapsed then the complete code point is preserved", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "js",
				durationMs: 1,
				toolCalls: [{ name: "unicode", ok: false, error: `${"x".repeat(511)}🙂${"tail".repeat(25_000)}` }],
				truncated: false,
			},
			"complete",
		);

		// When
		const lines = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		).render(2_048);

		// Then
		const toolStart = lines.findIndex((line) => line.includes("tool.unicode"));
		const toolLines = lines.slice(toolStart);
		const toolText = toolLines.join("\n");
		expect(toolStart).toBeGreaterThanOrEqual(0);
		expect(toolLines.length).toBeLessThanOrEqual(4);
		expect(toolText).toContain("🙂");
		expect(toolText).not.toContain("�");
		expect(toolText).not.toMatch(/[\uD800-\uDFFF]/u);
	});
});
