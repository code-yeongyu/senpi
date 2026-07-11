import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { callContext, evalResult, renderLines, resultContext } from "./eval-render-fixtures.ts";

describe("eval renderer", () => {
	it("renders call header metadata and code preview when present", () => {
		// Given
		const givenArgs = {
			language: "py",
			code: "  print('hello')\nprint('later')",
			title: "setup",
			reset: true,
			timeout: 3,
		} satisfies Parameters<typeof renderEvalCall>[0];

		// When
		const component = renderEvalCall(givenArgs, undefined, callContext());

		// Then
		expect(renderLines(component)).toEqual(["eval py setup reset timeout 3s", "  print('hello')", "print('later')"]);
	});

	it("renders an ellipsis for empty call code", () => {
		// Given
		const givenArgs = {
			language: "jl",
			code: "   ",
		} satisfies Parameters<typeof renderEvalCall>[0];

		// When
		const component = renderEvalCall(givenArgs, undefined, callContext());

		// Then
		expect(renderLines(component)).toEqual(["eval jl", "..."]);
	});

	it("renders completed result text while hiding image placeholders when images are disabled", () => {
		// Given
		const givenResult = {
			content: [
				{ type: "text", text: "stdout\nvalue" },
				{ type: "image", data: "abc123", mimeType: "image/png" },
			],
			details: {
				language: "js",
				title: "chart",
				durationMs: 11,
				toolCalls: [
					{ name: "search", ok: true },
					{ name: "write", ok: false, error: "denied" },
				],
				truncated: true,
			},
		} satisfies AgentToolResult<EvalToolDetails>;

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component)).toEqual([
			"eval js chart done",
			"took 11ms",
			"",
			"stdout",
			"value",
			"",
			"- tool.search: ok",
			"- tool.write: error (denied)",
			"",
			"[eval output truncated]",
		]);
	});

	it("renders an image placeholder when images are enabled", () => {
		// Given
		const givenResult = {
			content: [
				{ type: "text", text: "stdout\nvalue" },
				{ type: "image", data: "abc123", mimeType: "image/png" },
			],
			details: {
				language: "js",
				title: "chart",
				durationMs: 11,
				toolCalls: [
					{ name: "search", ok: true },
					{ name: "write", ok: false, error: "denied" },
				],
				truncated: true,
			},
		} satisfies AgentToolResult<EvalToolDetails>;

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, true),
		);

		// Then
		expect(renderLines(component)).toContain("[image: image/png]");
	});

	it("renders an error result header", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "rb",
				durationMs: 5,
				toolCalls: [],
				truncated: false,
				isError: true,
			},
			"boom",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component).slice(0, 2)).toEqual(["eval rb error", "took 5ms"]);
	});

	it("renders a running result header", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "py",
				title: "stream",
				durationMs: 0,
				toolCalls: [],
				truncated: false,
			},
			"partial",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component)[0]).toBe("eval py stream running");
	});

	it("reuses the call component when a later call render receives it as lastComponent", () => {
		// Given
		const first = renderEvalCall({ language: "js", code: "first()" }, undefined, callContext());

		// When
		const second = renderEvalCall({ language: "js", code: "second()" }, undefined, callContext(first));

		// Then
		expect(second).toBe(first);
		expect(renderLines(second)).toEqual(["eval js", "second()"]);
	});

	it("reuses the result component from partial to final result when it is passed as lastComponent", () => {
		// Given
		const partial = renderEvalResult(
			evalResult({ language: "js", durationMs: 0, toolCalls: [], truncated: false }, "still running"),
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// When
		const final = renderEvalResult(
			evalResult({ language: "js", durationMs: 4, toolCalls: [], truncated: false }, "complete"),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(partial, false),
		);

		// Then
		expect(final).toBe(partial);
		expect(renderLines(final)).toEqual(["eval js done", "took 4ms", "", "complete"]);
	});

	it("keeps call and result lanes distinct when the result lane starts without lastComponent", () => {
		// Given
		const call = renderEvalCall({ language: "js", code: "1 + 1" }, undefined, callContext());

		// When
		const result = renderEvalResult(
			evalResult({ language: "js", durationMs: 1, toolCalls: [], truncated: false }, "2"),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(result).not.toBe(call);
		expect(renderLines(call)).toEqual(["eval js", "1 + 1"]);
		expect(renderLines(result)).toEqual(["eval js done", "took 1ms", "", "2"]);
	});
});
