import { describe, expect, it } from "vitest";
import { renderEvalResult } from "../src/tool/render.ts";
import { evalResult, renderLines, resultContext } from "./eval-render-fixtures.ts";

describe("eval result duration rendering", () => {
	it.each([
		{ durationMs: 0, expected: "took <1s" },
		{ durationMs: 1_250, expected: "took 1s" },
		{ durationMs: 61_000, expected: "took 1m 1s" },
		{ durationMs: 3_720_000, expected: "took 1h 2m" },
	])("formats $durationMs milliseconds as $expected", ({ durationMs, expected }) => {
		// Given
		const result = evalResult({ language: "js", durationMs, toolCalls: [], truncated: false }, "complete");

		// When
		const rendered = renderLines(
			renderEvalResult(result, { expanded: false, isPartial: false }, undefined, resultContext(undefined, false)),
		);

		// Then
		expect(rendered).toContain(expected);
	});

	it("preserves result status summary phase and output around formatted timing", () => {
		// Given
		const result = evalResult(
			{
				language: "js",
				summary: "dependency scan",
				phase: "summarizing",
				durationMs: 1_250,
				toolCalls: [],
				truncated: false,
			},
			"complete",
		);

		// When
		const rendered = renderLines(
			renderEvalResult(result, { expanded: false, isPartial: false }, undefined, resultContext(undefined, false)),
		);

		// Then
		expect(rendered).toEqual(["eval js done", "dependency scan", "phase summarizing | took 1s", "", "complete"]);
	});
});

describe("eval result throughput rendering", () => {
	it.each([
		{ calls: 2, wallDurationMs: 2_000, expected: "2 calls · 1.00 calls/s" },
		{ calls: 3, wallDurationMs: 1_500, expected: "3 calls · 2.00 calls/s" },
		{ calls: 1, wallDurationMs: 400, expected: "1 call · 2.50 calls/s" },
		{ calls: 0, wallDurationMs: 0, expected: "0 calls · 0.00 calls/s" },
		{ calls: 0, wallDurationMs: 900, expected: "0 calls · 0.00 calls/s" },
		{ calls: 5, wallDurationMs: 0, expected: "5 calls · n/a calls/s" },
		{ calls: 7, wallDurationMs: undefined, expected: "7 calls · n/a calls/s" },
	])("renders $calls calls over $wallDurationMs wall ms as $expected", ({ calls, wallDurationMs, expected }) => {
		// Given
		const result = evalResult(
			{
				language: "js",
				durationMs: 2_000,
				toolCallCount: calls,
				wallDurationMs,
				toolCalls: [],
				truncated: false,
			},
			"complete",
		);

		// When
		const rendered = renderLines(
			renderEvalResult(result, { expanded: false, isPartial: false }, undefined, resultContext(undefined, false)),
		);

		// Then
		expect(rendered.join("\n")).toContain(expected);
	});

	it("uses wall-clock elapsed time for final metadata while preserving kernel duration in details", () => {
		// Given
		const result = evalResult(
			{
				language: "js",
				durationMs: 99,
				toolCallCount: 2,
				wallDurationMs: 2_000,
				toolCalls: [],
				truncated: false,
			},
			"complete",
		);

		// When
		const rendered = renderLines(
			renderEvalResult(result, { expanded: false, isPartial: false }, undefined, resultContext(undefined, false)),
		);

		// Then
		expect(rendered).toContain("took 2s | 2 calls · 1.00 calls/s");
		expect(rendered).not.toContain("took <1s");
	});
});
