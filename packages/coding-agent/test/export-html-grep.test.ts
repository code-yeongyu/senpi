import { describe, expect, it } from "vitest";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { GrepToolDetails } from "../src/core/tools/grep.ts";
import { grepRenderers } from "../src/core/tools/renderers/grep.ts";
import type { Theme, ThemeColor } from "../src/modes/interactive/theme/theme.ts";

const passthroughTheme = {
	bold: (value: string) => value,
	fg: (_key: ThemeColor, value: string) => value,
} as unknown as Theme;

const grepTool = {
	name: "grep",
	label: "grep",
	description: "grep",
	...grepRenderers,
} as unknown as ToolDefinition;

function details(): GrepToolDetails {
	return {
		version: 1,
		engine: "rg",
		status: "ok",
		cwd: "/tmp/project",
		paths: ["/tmp/project"],
		matches: [
			{ path: "src/a.ts", line: 12, text: "const needle = true;", isContext: false, truncated: false },
			{ path: "src/a.ts", line: 13, text: "after", isContext: true, truncated: false },
		],
		fileMatches: [{ path: "src/a.ts", count: 1 }],
		matchCount: 1,
		fileCount: 1,
		skip: 0,
		nextSkip: null,
		fileLimitReached: false,
		perFileLimitReached: false,
		totalLimitReached: false,
		scan: {
			counts: { matches: 1, files: 1, exact: true },
			filesSearched: 1,
			limitReached: false,
			perFileLimitReached: false,
			skippedOversized: 0,
			prefixSearched: 0,
			skippedBinary: 0,
			missingPaths: [],
			warnings: [],
			timedOut: false,
			elapsedMs: 3,
			effectivePattern: "needle",
			patternKind: "regex",
			regexEngine: "rust",
		},
	};
}

describe("export HTML grep rendering", () => {
	it("renders a grep result through the TUI renderer with a file header and match row", () => {
		const renderer = createToolHtmlRenderer({
			getToolDefinition: (name) => (name === "grep" ? grepTool : undefined),
			theme: passthroughTheme,
			cwd: "/tmp/project",
		});
		const html = renderer.renderResult("grep-1", "grep", [{ type: "text", text: "" }], details(), false);
		const expanded = html?.expanded ?? "";
		expect(expanded).toContain("src/a.ts");
		expect(expanded).toContain("12:");
		expect(expanded).toContain("const needle = true;");
	});
});
