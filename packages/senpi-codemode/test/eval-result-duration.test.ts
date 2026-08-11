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
