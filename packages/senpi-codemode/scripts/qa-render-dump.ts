import { initTheme, type AgentToolResult, Theme, type ThemeColor } from "@code-yeongyu/senpi";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails, EvalToolInput } from "../src/tool/types.ts";

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
} satisfies Record<ThemeColor, string>;

const BG_COLORS = {
	selectedBg: "#303030",
	userMessageBg: "#313131",
	customMessageBg: "#323232",
	toolPendingBg: "#333333",
	toolSuccessBg: "#343434",
	toolErrorBg: "#353535",
};

const TEST_THEME = new Theme(FG_COLORS, BG_COLORS, "truecolor", { name: "qa-render-dump" });
initTheme();

let fixture: "success" | "error" | undefined;
let width = 100;
for (let index = 2; index < process.argv.length; index += 1) {
	const argument = process.argv[index];
	if (argument === "--fixture") {
		const value = process.argv[index + 1];
		if (value !== "success" && value !== "error") throw new TypeError("--fixture must be success or error");
		fixture = value;
		index += 1;
		continue;
	}
	if (argument === "--width") {
		const value = Number(process.argv[index + 1]);
		if (!Number.isInteger(value) || value < 10) throw new RangeError("--width must be an integer >= 10");
		width = value;
		index += 1;
		continue;
	}
	throw new TypeError(`Unknown argument: ${argument}`);
}
if (fixture === undefined) throw new TypeError("--fixture is required");

const input: EvalToolInput = {
	language: "py",
	code: fixture === "success" ? "config = read('/tmp/config.json')" : "print('korean-output-test')",
	title: fixture === "success" ? "load config" : "failed cell",
};
const statusEvents =
	fixture === "success"
		? [
				{ op: "read", path: "/tmp/config.json", chars: 42 },
				{ op: "write", path: "/tmp/result.json", chars: 18 },
				{ op: "agent", id: "agent-success", status: "completed", durationMs: 1_200 },
			]
		: [
				{ op: "read", path: "/tmp/settings.json", chars: 12 },
				{ op: "write", path: "/tmp/result.json", chars: 8 },
				{ op: "agent", id: "agent-error", status: "completed", durationMs: 700 },
			];
const details: EvalToolDetails = {
	language: "py",
	...(fixture === "success" ? { title: "load config" } : {}),
	durationMs: fixture === "success" ? 1_250 : 900,
	toolCalls:
		fixture === "success"
			? [
					{
						name: "read",
						ok: true,
						callId: "qa-read",
						args: { path: "/tmp/config.json" },
						durationMs: 1_200,
						resultPreview: "loaded configuration",
					},
					{
						name: "bash",
						ok: false,
						callId: "qa-bash",
						args: { command: "exit 1" },
						durationMs: 300,
						error: "exit code 1",
					},
					{ name: "completion", ok: true },
				]
			: [],
	truncated: fixture === "error",
	...(fixture === "error" ? { isError: true } : {}),
	cells: [
		{
			index: 0,
			title: fixture === "success" ? "load config" : "failed cell",
			code: input.code,
			language: "py",
			output:
				fixture === "success"
					? "loaded configuration"
					: "korean-output-test and this very long error description must wrap safely even on a narrow screen",
			status: fixture === "success" ? "complete" : "error",
			durationMs: fixture === "success" ? 1_250 : 900,
			statusEvents,
		},
	],
	statusEvents,
	jsonOutputs: [{ a: 1 }],
	...(fixture === "error"
		? {
				meta: {
					direction: "tail",
					truncatedBy: "lines",
					totalLines: 12,
					totalBytes: 240,
					outputLines: 3,
					outputBytes: 60,
					shownRange: { start: 10, end: 12 },
					artifactId: "/tmp/senpi-codemode-full-output.log",
				},
			}
		: {}),
};
const result: AgentToolResult<EvalToolDetails> = { content: [{ type: "text", text: "" }], details };
const callContext = {
	args: input,
	toolCallId: "qa-render-call",
	invalidate: () => {},
	lastComponent: undefined,
	state: {},
	cwd: process.cwd(),
	executionStarted: false,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	imageProtocol: null,
	isError: false,
} satisfies Parameters<typeof renderEvalCall>[2];
const resultContext = {
	...callContext,
	toolCallId: "qa-render-result",
	executionStarted: true,
	isError: fixture === "error",
} satisfies Parameters<typeof renderEvalResult>[3];
const rendered = [
	...(fixture === "success" ? renderEvalCall(input, undefined, callContext).render(width) : []),
	...renderEvalResult(result, { expanded: false, isPartial: false }, TEST_THEME, resultContext).render(width),
];
const plainLines = rendered.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
for (const line of plainLines) console.log(line);
console.log(`MAXWIDTH:${Math.max(0, ...plainLines.map((line) => visibleWidth(line)))}`);
