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

	it("Given completed cell details when rendered then framed status agent and JSON output are visible", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "py",
				title: "load config",
				durationMs: 1_250,
				toolCalls: [],
				truncated: false,
				cells: [
					{
						index: 0,
						title: "load config",
						code: "config = {'a': 1}",
						language: "py",
						output: "loaded",
						status: "complete",
						durationMs: 1_250,
						statusEvents: [
							{ op: "read", path: "/tmp/config.json", chars: 42 },
							{ op: "write", path: "/tmp/result.json", chars: 18 },
						],
					},
				],
				jsonOutputs: [{ a: 1 }],
			},
			"",
		);

		// When
		const lines = renderLines(
			renderEvalResult(givenResult, { expanded: false, isPartial: false }, undefined, resultContext()),
		);
		const text = lines.join("\n");

		// Then
		expect.soft(lines[0]).toContain("╭─");
		expect.soft(text).toContain("eval py load config done");
		expect.soft(text).toContain("✓");
		expect.soft(text).toContain("1s");
		expect.soft(text).toContain("read 42 chars · from /tmp/config.json");
		expect.soft(text).toContain("write 18 chars · to /tmp/result.json");
		expect.soft(text).toContain("display[1]");
		expect.soft(text).toMatch(/a: 1/u);
	});

	it("Given the supported status event matrix when expanded then each operation has a useful summary", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "js",
				durationMs: 2,
				toolCalls: [],
				truncated: false,
				cells: [
					{
						index: 0,
						code: "run()",
						language: "js",
						output: "ok",
						status: "complete",
						statusEvents: [
							{ op: "cat", files: 2, chars: 9 },
							{ op: "ls", count: 3 },
							{ op: "env", action: "set", key: "TOKEN", value: "secret" },
							{ op: "git_status", staged: 1, modified: 2, untracked: 3, branch: "main" },
							{ op: "git_diff", lines: 12, staged: true },
							{ op: "git_log", commits: 4 },
							{ op: "run", command: "node script.js", exitCode: 0 },
							{ op: "completion", model: "slow-model", tier: "slow", chars: 25 },
							{ op: "log", message: "checkpoint" },
							{ op: "phase", title: "finalize" },
						],
					},
				],
			},
			"",
		);

		// When
		const text = renderEvalResult(
			givenResult,
			{ expanded: true, isPartial: false },
			undefined,
			resultContext({ expanded: true }),
		)
			.render(120)
			.join("\n");

		// Then
		for (const summary of [
			"cat 2 files · 9 chars",
			"ls 3 entries",
			"env set TOKEN=secret",
			"git_status 1 staged, 2 modified, 3 untracked · on main",
			"git_diff 12 lines · staged",
			"git_log 4 commits",
			"run node script.js · exit 0",
			"completion slow-model · slow · 25 chars",
			"log checkpoint",
			"phase finalize",
		]) {
			expect.soft(text).toContain(summary);
		}
	});
});
