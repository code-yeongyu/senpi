import { describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../../src/core/extensions/types.ts";
import type { GrepEngineMatch } from "../../src/core/tools/grep/engine.ts";
import type { GrepToolDetails } from "../../src/core/tools/grep.ts";
import { grepRenderers } from "../../src/core/tools/renderers/grep.ts";
import type { Theme, ThemeColor } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const passthroughTheme = {
	bold: (value: string) => value,
	fg: (_key: ThemeColor, value: string) => value,
} as unknown as Theme;

function scan(overrides: Partial<GrepToolDetails["scan"]> = {}): GrepToolDetails["scan"] {
	return {
		counts: { matches: 2, files: 2, exact: true },
		filesSearched: 4,
		limitReached: false,
		perFileLimitReached: false,
		skippedOversized: 0,
		prefixSearched: 0,
		skippedBinary: 0,
		missingPaths: [],
		warnings: [],
		timedOut: false,
		elapsedMs: 8,
		effectivePattern: "needle",
		patternKind: "regex",
		regexEngine: "rust",
		...overrides,
	};
}

function details(overrides: Partial<GrepToolDetails> = {}): GrepToolDetails {
	const matches: GrepEngineMatch[] = [
		{ path: "src/a.ts", line: 12, text: "const needle = true;", isContext: false, truncated: false },
		{ path: "src/a.ts", line: 13, text: "after", isContext: true, truncated: false },
		{ path: "src/b.ts", line: 7, text: "another needle", isContext: false, truncated: false },
	];
	return {
		version: 1,
		engine: "native",
		status: "ok",
		cwd: "/tmp/project",
		paths: ["/tmp/project"],
		matches,
		fileMatches: [
			{ path: "src/a.ts", count: 1 },
			{ path: "src/b.ts", count: 1 },
		],
		matchCount: 2,
		fileCount: 2,
		skip: 0,
		nextSkip: 20,
		fileLimitReached: true,
		perFileLimitReached: false,
		totalLimitReached: false,
		scan: scan(),
		...overrides,
	};
}

function renderContext(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: { pattern: "needle", path: "src" },
		toolCallId: "grep-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp/project",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		hasResult: true,
		...overrides,
	};
}

function renderCall(args: Record<string, unknown>): string {
	const component = grepRenderers.renderCall?.(args as never, passthroughTheme, renderContext({ args }));
	return stripAnsi(component?.render(120).join("\n") ?? "");
}

function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails },
	expanded: boolean,
): string {
	const component = grepRenderers.renderResult?.(
		result as never,
		{ expanded, isPartial: false },
		passthroughTheme,
		renderContext({ expanded }),
	);
	return stripAnsi(component?.render(120).join("\n") ?? "");
}

describe("grep TUI renderer", () => {
	it("renders the call line with pattern, paths, glob, mode, and skip", () => {
		const text = renderCall({
			pattern: "needle",
			path: ["src", "lib"],
			glob: "*.ts",
			mode: "content",
			skip: 20,
		});
		expect(text).toContain("grep");
		expect(text).toContain("/needle/");
		expect(text).toContain("src");
		expect(text).toContain("lib");
		expect(text).toContain("*.ts");
		expect(text).toContain("content");
		expect(text).toContain("skip 20");
	});

	it("renders grouped matches with a file header and 12: row, without a statistics footer", () => {
		const text = renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: details(),
			},
			true,
		);
		expect(text).toContain("src/a.ts");
		expect(text).toContain("12:");
		expect(text).toContain("const needle = true;");
		expect(text).not.toContain("[grep: matches=");
		expect(text).not.toContain("nextSkip=");
	});

	it("hides context rows when collapsed and shows them when expanded", () => {
		const result = { content: [{ type: "text", text: "" }], details: details() };
		const collapsed = renderResult(result, false);
		const expanded = renderResult(result, true);

		expect(collapsed).toContain("src/a.ts");
		expect(collapsed).toContain("12:");
		expect(collapsed).not.toContain("nextSkip=");
		expect(collapsed).not.toContain("13-");
		expect(collapsed).not.toContain("after");

		expect(expanded).toContain("13-");
		expect(expanded).toContain("after");
		expect(expanded).toContain("src/b.ts");
		expect(expanded).toContain("7:");
	});

	it("omits renderer-owned truncation warnings while preserving matches", () => {
		const text = renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: details({
					totalLimitReached: true,
					matchCount: 100,
					linesTruncated: true,
				}),
			},
			true,
		);
		expect(text.toLowerCase()).not.toContain("truncated");
		expect(text).toContain("const needle = true;");
		expect(text).not.toContain("[Truncated:");
	});

	it("falls back to tool text when details are absent", () => {
		const text = renderResult(
			{
				content: [
					{
						type: "text",
						text: "src/fallback.ts\n4: fallback needle\n\n[grep: matches=1 files=1 searched=1 elapsedMs=1 engine=rg nextSkip=none]",
					},
				],
			},
			true,
		);
		expect(text).toContain("src/fallback.ts");
		expect(text).toContain("4:");
		expect(text).toContain("fallback needle");
	});
});
