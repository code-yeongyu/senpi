import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initTheme, Theme, type AgentToolResult } from "@code-yeongyu/senpi";
import { colorToHex, parseColor } from "@earendil-works/pi-tui";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalCellResult, EvalToolDetails, EvalToolInput } from "../src/tool/types.ts";

const STARTED_AT = 1_700_000_000_000;
const STATES = [
	"streaming-short",
	"streaming-long",
	"streaming-python",
	"streaming-long-sql",
	"running",
	"queued",
	"done",
	"error",
	"expanded-done",
	"expanded-error",
] as const;
type State = (typeof STATES)[number];

let state: State | undefined;
let themeName: "dark" | "light" = "dark";
let width = 80;
for (let index = 2; index < process.argv.length; index += 1) {
	const argument = process.argv[index];
	if (argument === "--state") {
		const value = process.argv[index + 1];
		const parsed = STATES.find((candidate) => candidate === value);
		if (parsed === undefined) throw new TypeError(`--state must be one of ${STATES.join(", ")}`);
		state = parsed;
		index += 1;
		continue;
	}
	if (argument === "--theme") {
		const value = process.argv[index + 1];
		if (value !== "dark" && value !== "light") throw new TypeError("--theme must be dark or light");
		themeName = value;
		index += 1;
		continue;
	}
	if (argument === "--width") {
		const value = Number(process.argv[index + 1]);
		if (!Number.isInteger(value) || value < 20) throw new RangeError("--width must be an integer >= 20");
		width = value;
		index += 1;
		continue;
	}
	throw new TypeError(`Unknown argument: ${argument}`);
}
if (state === undefined) throw new TypeError("--state is required");

type ThemeJson = {
	readonly vars: Record<string, string>;
	readonly colors: Record<string, string>;
};
function hex(theme: ThemeJson, token: string): string {
	const seen = new Set<string>();
	let value: string | undefined = theme.colors[token] ?? theme.vars[token];
	while (value !== undefined && theme.vars[value] !== undefined && !seen.has(value)) {
		seen.add(value);
		value = theme.vars[value];
	}
	// Tokens absent from a bundled theme (e.g. skillMention) fall back to the muted lane.
	if (value === undefined) return hex(theme, "muted");
	return colorToHex(parseColor(value));
}
const themeDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../coding-agent/src/modes/interactive/theme",
);
const themeJson = JSON.parse(readFileSync(join(themeDir, `${themeName}.json`), "utf8")) as ThemeJson;
const FG_TOKENS = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
	"syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
	"syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode", "searchMatchText", "skillMention", "scrollbarTrack", "scrollbarThumb",
] as const;
const BG_TOKENS = [
	"selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
] as const;
const fg = Object.fromEntries(FG_TOKENS.map((token) => [token, hex(themeJson, token)]));
const bg = Object.fromEntries(BG_TOKENS.map((token) => [token, hex(themeJson, token)]));
const theme = new Theme(fg as never, bg as never, "truecolor", { name: `qa-${themeName}` });
initTheme();

const LONG_CODE = Array.from({ length: 20 }, (_, index) => `const step${index + 1} = await phase(${index + 1});`).join("\n");
const SHORT_CODE = "const answer = 42;\nprint(answer);";
const PY_INDENTED_CODE = [
	"for i in range(4):",
	"    if i % 2:",
	"        print(f'odd {i}')",
	"    else:",
	"        print(f'even {i}')",
	"print('indented python done')",
].join("\n");
const LONG_SQL_CODE = [
	'const q = "SELECT u.id, u.name, u.email, o.total, o.created_at FROM users u JOIN orders o ON o.user_id = u.id WHERE o.total > 100 ORDER BY o.created_at DESC LIMIT 50";',
	"const rows = await db.query(q);",
	"for (const row of rows) {",
	"  print(row.name);",
	"}",
	'print("done");',
].join("\n");
const RUN_CODE = Array.from({ length: 8 }, (_, index) => `await tick(${index + 1});`).join("\n");

function cell(overrides: Partial<EvalCellResult>): EvalCellResult {
	return {
		index: 0,
		summary: "stream the build log tail",
		code: RUN_CODE,
		language: "js",
		output: "",
		status: "running",
		startedAt: STARTED_AT,
		...overrides,
	};
}
function detailsFor(cells: EvalCellResult[]): EvalToolDetails {
	return { language: "js", durationMs: 3_400, toolCalls: [], truncated: false, cells };
}
function resultFor(cells: EvalCellResult[], isError = false): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: "" }],
		details: { ...detailsFor(cells), ...(isError ? { isError: true } : {}) },
	};
}

const context = {
	args: { language: "js", code: LONG_CODE, summary: "stream the build log tail" } satisfies EvalToolInput,
	toolCallId: "qa-eval-live-block",
	invalidate: () => {},
	lastComponent: undefined,
	state: {},
	cwd: process.cwd(),
	executionStarted: true,
	argsComplete: true,
	isPartial: true,
	expanded: false,
	showImages: false,
	imageProtocol: null,
	isError: false,
	spinnerFrame: 3,
	now: STARTED_AT + 3_400,
} as const;

let lines: string[];
switch (state) {
	case "streaming-short":
		lines = renderEvalCall(
			{ language: "js", code: SHORT_CODE, summary: "compute the answer" },
			theme,
			{ ...context, args: { language: "js", code: SHORT_CODE, summary: "compute the answer" } } as never,
		).render(width);
		break;
	case "streaming-long":
		lines = renderEvalCall({ language: "js", code: LONG_CODE, summary: "stream the build log tail" }, theme, context as never).render(width);
		break;
	case "streaming-python":
		lines = renderEvalCall(
			{ language: "py", code: PY_INDENTED_CODE, summary: "indented python loop" },
			theme,
			{ ...context, args: { language: "py", code: PY_INDENTED_CODE, summary: "indented python loop" } } as never,
		).render(width);
		break;
	case "streaming-long-sql":
		lines = renderEvalCall(
			{ language: "js", code: LONG_SQL_CODE, summary: "long sql query" },
			theme,
			{ ...context, args: { language: "js", code: LONG_SQL_CODE, summary: "long sql query" } } as never,
		).render(width);
		break;
	case "running":
		lines = renderEvalResult(
			resultFor([cell({ output: "chunk 18\nchunk 19\nchunk 20" })]),
			{ expanded: false, isPartial: true },
			theme,
			context as never,
		).render(width);
		break;
	case "queued":
		lines = renderEvalResult(
			resultFor([cell({ status: "queued", queuedBehind: ["cell-17"], startedAt: undefined })]),
			{ expanded: false, isPartial: true },
			theme,
			context as never,
		).render(width);
		break;
	case "done":
	case "expanded-done":
		lines = renderEvalResult(
			resultFor([cell({ status: "complete", durationMs: 3_400, output: "build passed\n20 steps", startedAt: undefined })]),
			{ expanded: state === "expanded-done", isPartial: false },
			theme,
			{ ...context, expanded: state === "expanded-done" } as never,
		).render(width);
		break;
	case "error":
	case "expanded-error":
		lines = renderEvalResult(
			resultFor(
				[cell({ status: "error", durationMs: 1_200, output: "TypeError: phase is not a function", startedAt: undefined })],
				true,
			),
			{ expanded: state === "expanded-error", isPartial: false },
			theme,
			{ ...context, expanded: state === "expanded-error", isError: true } as never,
		).render(width);
		break;
}
for (const line of lines) console.log(line);
