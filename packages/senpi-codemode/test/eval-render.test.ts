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
			summary: "setup",
			reset: true,
			timeout: 3,
		} satisfies Parameters<typeof renderEvalCall>[0];

		// When
		const component = renderEvalCall(givenArgs, undefined, callContext());

		// Then
		expect(renderLines(component)).toEqual([
			"eval py reset timeout 3s",
			"setup",
			"  print('hello')",
			"print('later')",
		]);
	});

	it("renders an ellipsis for empty call code", () => {
		// Given
		const givenArgs = {
			language: "jl",
			code: "   ",
			summary: "blank cell",
		} satisfies Parameters<typeof renderEvalCall>[0];

		// When
		const component = renderEvalCall(givenArgs, undefined, callContext());

		// Then
		expect(renderLines(component)).toEqual(["eval jl", "blank cell", "..."]);
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
				summary: "chart",
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
			"eval js done",
			"chart",
			"took <1s",
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
				summary: "chart",
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
		expect(renderLines(component).slice(0, 2)).toEqual(["eval rb error", "took <1s"]);
	});

	it("renders a running result header", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "py",
				summary: "stream",
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
		expect(renderLines(component)[0]).toBe("eval py running");
		expect(renderLines(component)[1]).toBe("stream");
	});

	it("Given legacy stored details carrying title and no summary when rendered then no label line and no crash", () => {
		// Given a pre-summary stored payload: title survived in old sessions, summary never existed.
		// The cast simulates legacy data rehydrated into the current details shape.
		const legacyCellDetails = {
			language: "py",
			title: "legacy label",
			durationMs: 3,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					title: "legacy label",
					code: "print('old')",
					language: "py",
					output: "old",
					status: "complete",
					durationMs: 3,
				},
			],
		} as unknown as EvalToolDetails;
		const legacyFallbackDetails = {
			language: "py",
			title: "legacy label",
			durationMs: 3,
			toolCalls: [],
			truncated: false,
		} as unknown as EvalToolDetails;

		// When the cell frame and the fallback frame (no cells) render collapsed and expanded
		const renders = [
			...renderLines(
				renderEvalResult(
					evalResult(legacyCellDetails, "old"),
					{ expanded: false, isPartial: false },
					undefined,
					resultContext(),
				),
			),
			...renderEvalResult(
				evalResult(legacyCellDetails, "old"),
				{ expanded: true, isPartial: false },
				undefined,
				resultContext({ expanded: true }),
			).render(80),
			...renderLines(
				renderEvalResult(
					evalResult(legacyFallbackDetails, "old"),
					{ expanded: false, isPartial: false },
					undefined,
					resultContext(),
				),
			),
		];

		// Then every frame renders without crashing and none emits a standalone label line
		expect(renders.length).toBeGreaterThan(0);
		expect(renders.some((line) => line.trim() === "legacy label")).toBe(false);
	});

	it("reuses the call component when a later call render receives it as lastComponent", () => {
		// Given
		const first = renderEvalCall(
			{ language: "js", code: "first()", summary: "first pass" },
			undefined,
			callContext(),
		);

		// When
		const second = renderEvalCall(
			{ language: "js", code: "second()", summary: "second pass" },
			undefined,
			callContext(first),
		);

		// Then
		expect(second).toBe(first);
		expect(renderLines(second)).toEqual(["eval js", "second pass", "second()"]);
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
		expect(renderLines(final)).toEqual(["eval js done", "took <1s", "", "complete"]);
	});

	it("keeps call and result lanes distinct when the result lane starts without lastComponent", () => {
		// Given
		const call = renderEvalCall({ language: "js", code: "1 + 1", summary: "quick math" }, undefined, callContext());

		// When
		const result = renderEvalResult(
			evalResult({ language: "js", durationMs: 1, toolCalls: [], truncated: false }, "2"),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext(undefined, false),
		);

		// Then
		expect(result).not.toBe(call);
		expect(renderLines(call)).toEqual(["eval js", "quick math", "1 + 1"]);
		expect(renderLines(result)).toEqual(["eval js done", "took <1s", "", "2"]);
	});

	it("Given a streaming result exists when the framed call lane renders then it yields an empty component", () => {
		// Given a framed call render (spinnerFrame set) that would otherwise draw its own pending/running box
		const withoutResult = renderEvalCall(
			{ language: "py", code: "print('x')", summary: "print probe" },
			undefined,
			callContext({ spinnerFrame: 0 }),
		);

		// When the same call lane renders after a result has arrived
		const withResult = renderEvalCall(
			{ language: "py", code: "print('x')", summary: "print probe" },
			undefined,
			callContext({ spinnerFrame: 0, hasResult: true }),
		);

		// Then only the pre-result render draws a frame; the post-result call lane is empty
		expect.soft(renderLines(withoutResult).some((line) => line.includes("╭─"))).toBe(true);
		expect.soft(renderLines(withResult)).toEqual([]);
	});

	it("Given a result exists when the compact call lane renders then it also yields an empty component", () => {
		// Given the compact call preview (no theme, no spinner) and the same lane once a result exists
		const compact = renderEvalCall(
			{ language: "js", code: "1 + 1", summary: "quick math" },
			undefined,
			callContext(),
		);
		const yielded = renderEvalCall(
			{ language: "js", code: "1 + 1", summary: "quick math" },
			undefined,
			callContext({ hasResult: true }),
		);

		// Then the pre-result preview renders code while the post-result lane is empty
		expect.soft(renderLines(compact)).toEqual(["eval js", "quick math", "1 + 1"]);
		expect.soft(renderLines(yielded)).toEqual([]);
	});

	it("Given completed cell details when rendered then framed status agent and JSON output are visible", () => {
		// Given
		const givenResult = evalResult(
			{
				language: "py",
				summary: "load config",
				durationMs: 1_250,
				toolCalls: [],
				truncated: false,
				cells: [
					{
						index: 0,
						summary: "load config",
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
		expect.soft(text).toContain("eval py done");
		expect.soft(text).toContain("load config");
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
							{ op: "status-events-omitted", count: 26 },
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
		// The bound marker is folded into the omission summary line instead of rendering as its own row.
		expect(text).toContain("26 earlier status events");
		expect(text).not.toContain("status-events-omitted");
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

type NestedToolCall = {
	readonly name: string;
	readonly ok: boolean;
	readonly args?: unknown;
	readonly durationMs?: number;
	readonly resultPreview?: string;
	readonly error?: string;
};

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
	syntaxVariable: "#202020",
	syntaxString: "#222222",
	syntaxNumber: "#232323",
	syntaxType: "#242424",
	syntaxOperator: "#252525",
	syntaxPunctuation: "#262626",
	thinkingOff: "#272727",
	thinkingMinimal: "#282828",
	thinkingLow: "#292929",
	thinkingMedium: "#2a2a2a",
	thinkingHigh: "#292929",
	thinkingXhigh: "#2a2a2a",
	thinkingMax: "#2b2b2b",
	bashMode: "#2c2c2c",
};

const BG_COLORS = {
	selectedBg: "#303030",
	userMessageBg: "#313131",
	customMessageBg: "#323232",
	toolPendingBg: "#333333",
	toolSuccessBg: "#343434",
	toolErrorBg: "#353535",
};

function stripNestedAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/gu, "");
}

async function nestedToolResult(toolCalls: readonly NestedToolCall[]) {
	const { evalResultWithNestedToolCalls } = await import("./eval-render-fixtures.ts");
	return evalResultWithNestedToolCalls(toolCalls);
}

async function nestedWidgetTheme() {
	const { Theme, initTheme } = await import("@code-yeongyu/senpi");
	initTheme();
	return new Theme(FG_COLORS, BG_COLORS, "truecolor", { name: "eval-render-nested-widgets-test" });
}

describe("nested tool-call widgets", () => {
	it("nested widgets: legacy row string pinned", async () => {
		const lines = renderLines(
			renderEvalResult(
				await nestedToolResult([{ name: "read", ok: true }]),
				{ expanded: false, isPartial: false },
				undefined,
				resultContext(),
			),
		);

		expect(lines).toContain("- tool.read: ok");
	});

	it("nested widgets: enriched renders shapes", async () => {
		const theme = await nestedWidgetTheme();
		const lines = renderLines(
			renderEvalResult(
				await nestedToolResult([
					{
						name: "read",
						ok: true,
						args: { path: "/tmp/config.json" },
						durationMs: 1_200,
						resultPreview: "loaded configuration",
					},
					{ name: "bash", ok: false, args: { command: "echo nested" }, error: "exit 1" },
				]),
				{ expanded: false, isPartial: false },
				theme,
				resultContext(),
			),
		);
		const output = stripNestedAnsi(lines.join("\n"));

		expect(output).toContain("config.json");
		expect(output).toContain("$ echo nested");
		expect(output).toContain("✓");
		expect(output).toContain("✗");
	});

	it("nested widgets: mixed list", async () => {
		const theme = await nestedWidgetTheme();
		const output = stripNestedAnsi(
			renderLines(
				renderEvalResult(
					await nestedToolResult([
						{ name: "read", ok: true, args: { path: "/tmp/config.json" } },
						{ name: "completion", ok: true },
					]),
					{ expanded: false, isPartial: false },
					theme,
					resultContext(),
				),
			).join("\n"),
		);

		expect(output).toContain("config.json");
		expect(output).toContain("- tool.completion: ok");
	});

	it("nested widgets: theme undefined", async () => {
		const lines = renderLines(
			renderEvalResult(
				await nestedToolResult([{ name: "read", ok: true, args: { path: "/tmp/config.json" } }]),
				{ expanded: false, isPartial: false },
				undefined,
				resultContext(),
			),
		);

		expect(lines).toContain("- tool.read: ok");
		expect(lines.join("\n")).not.toContain("\u001b");
	});

	it("nested widgets: collapse budget", async () => {
		const theme = await nestedWidgetTheme();
		const calls = Array.from({ length: 8 }, (_, index) => ({
			name: "bash",
			ok: true,
			args: { command: `echo nested-${index + 1}` },
		}));
		const output = stripNestedAnsi(
			renderLines(
				renderEvalResult(
					await nestedToolResult(calls),
					{ expanded: false, isPartial: false },
					theme,
					resultContext(),
				),
			).join("\n"),
		);

		expect(output).toContain("3 earlier tool calls");
		for (const index of [4, 5, 6, 7, 8]) expect(output).toContain(`$ echo nested-${index}`);
		for (const index of [1, 2, 3]) expect(output).not.toContain(`$ echo nested-${index}`);
	});

	it("nested widgets: streaming partial", async () => {
		const theme = await nestedWidgetTheme();
		const output = stripNestedAnsi(
			renderLines(
				renderEvalResult(
					await nestedToolResult([{ name: "read", ok: true, args: { path: "/tmp/partial.json" } }]),
					{ expanded: false, isPartial: true },
					theme,
					resultContext(),
				),
			).join("\n"),
		);

		expect(output).toContain("partial.json");
	});
});
