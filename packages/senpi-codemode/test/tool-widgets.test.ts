import { initTheme, Theme, type ThemeColor } from "@code-yeongyu/senpi";
import { beforeAll, describe, expect, it } from "vitest";
import { renderToolCallWidget, type WidgetOptions } from "../src/tool/tool-widgets.ts";
import type { EvalToolCallSummary } from "../src/tool/types.ts";
import { stripAnsi } from "./eval-render-fixtures.ts";

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
	searchMatchText: "#2f2f2f",
} satisfies Record<ThemeColor, string>;

const BG_COLORS = {
	selectedBg: "#303030",
	userMessageBg: "#313131",
	customMessageBg: "#323232",
	toolPendingBg: "#333333",
	toolSuccessBg: "#343434",
	toolErrorBg: "#353535",
};

const TEST_THEME = new Theme(FG_COLORS, BG_COLORS, "truecolor", { name: "tool-widgets-test" });
const DEFAULT_OPTIONS: WidgetOptions = {
	cwd: "/tmp/project",
	theme: TEST_THEME,
	expanded: false,
	width: 80,
};

function render(summary: EvalToolCallSummary, options: Partial<WidgetOptions> = {}): string[] {
	return renderToolCallWidget(summary, { ...DEFAULT_OPTIONS, ...options });
}

function plain(lines: readonly string[]): string {
	return stripAnsi(lines.join("\n"));
}

function expectVisibleWidthAtMost(lines: readonly string[], width: number): void {
	for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
}

describe("nested tool-call widgets", () => {
	beforeAll(() => {
		initTheme();
	});

	it("widget: read renders the real call shape", () => {
		const lines = render({
			name: "read",
			ok: true,
			callId: "read-1",
			args: { path: "/tmp/project/config.json" },
			durationMs: 1_200,
			resultPreview: "loaded configuration",
		});
		const output = plain(lines);

		expect(output).toContain("config.json");
		expect(output).toContain("✓");
		expect(output).toContain("1s");
		expect(output).toContain("loaded configuration");
		expect(output).not.toContain("tool.read(");
	});

	it("widget: bash renders the real call shape", () => {
		const output = plain(render({ name: "bash", ok: true, args: { command: 'echo "hello"' } }));

		expect(output).toContain('$ echo "hello"');
		expect(output).not.toContain("tool.bash(");
	});

	it("widget: write renders the real call shape", () => {
		const output = plain(render({ name: "write", ok: true, args: { path: "notes.txt", content: "hello" } }));

		expect(output).toContain("write");
		expect(output).toContain("notes.txt");
		expect(output).not.toContain("tool.write(");
	});

	it("widget: grep renders the real call shape", () => {
		const output = plain(render({ name: "grep", ok: true, args: { pattern: "needle", path: "src" } }));

		expect(output).toContain("/needle/");
		expect(output).not.toContain("tool.grep(");
	});

	it("widget: find renders the real call shape", () => {
		const output = plain(render({ name: "find", ok: true, args: { pattern: "**/*.ts", path: "src" } }));

		expect(output).toContain("**/*.ts");
		expect(output).not.toContain("tool.find(");
	});

	it("widget: ls renders the real call shape", () => {
		const output = plain(render({ name: "ls", ok: true, args: { path: "src" } }));

		expect(output).toContain("ls");
		expect(output).toContain("src");
		expect(output).not.toContain("tool.ls(");
	});

	it("widget: edit deliberately renders the fallback row", () => {
		const output = plain(
			render({
				name: "edit",
				ok: true,
				args: { path: "src/config.ts", oldText: "before", newText: "after" },
			}),
		);

		expect(output).toContain("tool.edit(");
		expect(output).toContain("src/config.ts");
	});

	it("widget: schema mismatch renders the fallback row", () => {
		const output = plain(render({ name: "read", ok: true, args: {} }));

		expect(output).toContain("tool.read({})");
	});

	it("widget: unknown tool renders a sanitized fallback row", () => {
		const lines = render(
			{ name: "computer_use", ok: true, args: { action: "click\u001b[2Jevil" } },
			{ theme: undefined },
		);
		const output = lines.join("\n");

		expect(output).toContain("tool.computer_use(");
		expect(output).toContain("click");
		expect(output).toContain("evil");
		expect(output).not.toContain("\u001b");
	});

	it("widget: theme undefined uses the plain fallback with zero ANSI", () => {
		const lines = render(
			{ name: "read", ok: true, args: { path: "config.json" }, resultPreview: "loaded" },
			{ theme: undefined },
		);
		const output = lines.join("\n");

		expect(output).toContain("tool.read(");
		expect(output).toContain("config.json");
		expect(output).not.toContain("\u001b");
	});

	it("widget: theme-less hostile error strips terminal controls", () => {
		const escapeCharacter = String.fromCharCode(27);
		const lines = render(
			{ name: "computer_use", ok: false, args: {}, error: `boom${escapeCharacter}[2Jevil` },
			{ theme: undefined },
		);

		expect(lines.some((line) => [...line].some((character) => character.charCodeAt(0) === 27))).toBe(false);
		expect(lines.join("\n")).toContain("boom");
	});

	it("widget: themed expanded error preserves lines while stripping terminal controls", () => {
		const escapeCharacter = String.fromCharCode(27);
		const lines = render(
			{ name: "computer_use", ok: false, args: {}, error: `line1${escapeCharacter}[2J\nline2` },
			{ expanded: true },
		);
		const plainLines = lines.map(stripAnsi);
		const firstErrorLine = plainLines.indexOf("  line1");
		const secondErrorLine = plainLines.indexOf("  line2");

		expect(plainLines.some((line) => [...line].some((character) => character.charCodeAt(0) === 27))).toBe(false);
		expect(plainLines).toContain("  line2");
		expect(firstErrorLine).toBeGreaterThanOrEqual(0);
		expect(secondErrorLine).toBe(firstErrorLine + 1);
	});

	it("widget: width below the renderer floor uses the fallback", () => {
		const output = plain(render({ name: "read", ok: true, args: { path: "config.json" } }, { width: 15 }));

		expect(output).toContain("tool.read(");
		expect(output.replace(/\s+/gu, "")).toContain("config.json");
	});

	it("widget: collapsed error is guarded and marked when omitted", () => {
		const lines = render({ name: "read", ok: false, args: { path: "config.json" }, error: "denied ".repeat(200) });
		const output = plain(lines);

		expect(output).toContain("✗");
		expect(output).toContain("denied");
		expect(output).toContain("[tool error omitted]");
	});

	it("widget: args truncation is reported on the status line", () => {
		const output = plain(render({ name: "read", ok: true, args: { path: "config.json" }, argsTruncated: true }));

		expect(output).toContain("✓ (args truncated)");
	});

	it("widget: long fallback and preview lines wrap within width", () => {
		const lines = render(
			{
				name: "computer_use",
				ok: true,
				args: { action: "click-".repeat(40) },
				resultPreview: "preview ".repeat(30),
			},
			{ width: 24 },
		);

		expect(lines.length).toBeGreaterThan(3);
		expectVisibleWidthAtMost(lines, 24);
	});

	it("widget: renderer output over five lines is cut with a marker", () => {
		const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
		const lines = render({ name: "write", ok: true, args: { path: "many.ts", content } }, { expanded: true });
		const output = plain(lines);

		expect(output).toContain("… (widget truncated)");
		expect(lines.findIndex((line) => stripAnsi(line).includes("… (widget truncated)"))).toBe(5);
	});

	it("widget: collapsed budget at width 24", () => {
		const lines = render(
			{
				name: "computer_use",
				ok: false,
				args: { action: "click-".repeat(40) },
				error: "failure ".repeat(20),
			},
			{ width: 24, expanded: false },
		);

		expect(lines.length).toBeLessThanOrEqual(8);
		expectVisibleWidthAtMost(lines, 24);
	});

	it("widget: error-bit summary renders its error below the status", () => {
		const lines = render({ name: "read", ok: false, args: { path: "config.json" }, error: "permission denied" });
		const plainLines = lines.map(stripAnsi);
		const statusIndex = plainLines.findIndex((line) => line.includes("✗"));
		const errorIndex = plainLines.findIndex((line) => line.includes("permission denied"));

		expect(statusIndex).toBeGreaterThanOrEqual(0);
		expect(errorIndex).toBeGreaterThan(statusIndex);
	});
});
