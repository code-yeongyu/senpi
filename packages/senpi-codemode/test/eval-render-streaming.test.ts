import { describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import { callContext, evalResult, renderLines, resultContext } from "./eval-render-fixtures.ts";

describe("eval renderer streaming reuse", () => {
	it("Given first partial result when rendered then compact status and metadata rows are separate", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "py",
				title: "stream",
				phase: "setup",
				durationMs: 0,
				toolCalls: [],
				truncated: false,
			},
			"partial-one",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component).slice(0, 4)).toEqual(["eval py stream running", "phase setup", "", "partial-one"]);
	});

	it("Given second partial result when reused then stale output is replaced and nested tool rows render", () => {
		// Given
		const firstPartial = renderEvalResult(
			evalResult(
				{
					language: "py",
					title: "stream",
					phase: "setup",
					durationMs: 0,
					toolCalls: [],
					truncated: false,
				},
				"partial-one",
			),
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// When
		const secondPartial = renderEvalResult(
			evalResult(
				{
					language: "py",
					title: "stream",
					phase: "calling tools",
					durationMs: 0,
					toolCalls: [
						{ name: "search", ok: true },
						{ name: "write", ok: false, error: "denied" },
					],
					truncated: false,
				},
				"partial-two",
			),
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(firstPartial, false),
		);

		// Then
		const lines = renderLines(secondPartial);
		const visibleText = lines.join("\n");
		expect.soft(secondPartial).toBe(firstPartial);
		expect.soft(lines.slice(0, 2)).toEqual(["eval py stream running", "phase calling tools"]);
		expect.soft(lines).toContain("partial-two");
		expect.soft(lines).toContain("- tool.search: ok");
		expect.soft(lines).toContain("- tool.write: error (denied)");
		expect.soft(visibleText).not.toContain("partial-one");
		expect.soft(visibleText).toContain("denied");
	});

	it("Given final result when reused after partial then stale running state and output are replaced", () => {
		// Given
		const partial = renderEvalResult(
			evalResult(
				{
					language: "py",
					title: "stream",
					phase: "calling tools",
					durationMs: 0,
					toolCalls: [{ name: "search", ok: true }],
					truncated: false,
				},
				"partial-two",
			),
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// When
		const final = renderEvalResult(
			evalResult(
				{
					language: "py",
					title: "stream",
					phase: "complete",
					durationMs: 9,
					toolCalls: [],
					truncated: false,
				},
				"final-only",
			),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(partial, false),
		);

		// Then
		const lines = renderLines(final);
		const visibleText = lines.join("\n");
		expect.soft(final).toBe(partial);
		expect.soft(lines.slice(0, 4)).toEqual(["eval py stream done", "phase complete | took 9ms", "", "final-only"]);
		expect.soft(visibleText).not.toContain("partial-two");
		expect.soft(visibleText).not.toContain("running");
		expect.soft(visibleText).not.toContain("tool.search");
	});

	it("Given error finalization when reused after partial then stale running output is replaced", () => {
		// Given
		const partial = renderEvalResult(
			evalResult(
				{
					language: "rb",
					phase: "running script",
					durationMs: 0,
					toolCalls: [],
					truncated: false,
				},
				"still running",
			),
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// When
		const error = renderEvalResult(
			evalResult(
				{
					language: "rb",
					phase: "failed",
					durationMs: 5,
					toolCalls: [],
					truncated: false,
					isError: true,
				},
				"boom",
			),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(partial, false),
		);

		// Then
		const lines = renderLines(error);
		const visibleText = lines.join("\n");
		expect.soft(error).toBe(partial);
		expect.soft(lines.slice(0, 4)).toEqual(["eval rb error", "phase failed | took 5ms", "", "boom"]);
		expect.soft(visibleText).not.toContain("still running");
		expect.soft(visibleText).not.toContain("running script");
	});

	it("Given phase-only partial result when rendered then no-output marker is shown below metadata", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "js",
				phase: "waiting",
				durationMs: 0,
				toolCalls: [],
				truncated: false,
			},
			"",
		);

		// When
		const component = renderEvalResult(
			givenResult,
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(renderLines(component).slice(0, 4)).toEqual(["eval js running", "phase waiting", "", "(no output)"]);
	});

	it("Given separate call component when result streams then call preview remains distinct and unchanged", () => {
		// Given
		const call = renderEvalCall({ language: "js", code: "const value = 1" }, undefined, callContext());
		const callPreview = renderLines(call);
		const partial = renderEvalResult(
			evalResult(
				{
					language: "js",
					phase: "waiting",
					durationMs: 0,
					toolCalls: [],
					truncated: false,
				},
				"partial",
			),
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(undefined, false),
		);

		// When
		const final = renderEvalResult(
			evalResult(
				{
					language: "js",
					phase: "complete",
					durationMs: 3,
					toolCalls: [],
					truncated: false,
				},
				"final",
			),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(partial, false),
		);

		// Then
		expect.soft(final).toBe(partial);
		expect.soft(final).not.toBe(call);
		expect.soft(renderLines(call)).toEqual(callPreview);
		expect.soft(renderLines(call)).toEqual(["eval js", "const value = 1"]);
		expect.soft(renderLines(final).slice(0, 4)).toEqual(["eval js done", "phase complete | took 3ms", "", "final"]);
	});
});
