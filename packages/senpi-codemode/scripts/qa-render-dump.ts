import type { AgentToolResult } from "@code-yeongyu/senpi";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails, EvalToolInput } from "../src/tool/types.ts";

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
	code: fixture === "success" ? "config = read('/tmp/config.json')" : "print('한글출력테스트')",
	title: fixture === "success" ? "load config" : "실패 셀",
};
const statusEvents =
	fixture === "success"
		? [
				{ op: "read", path: "/tmp/config.json", chars: 42 },
				{ op: "write", path: "/tmp/result.json", chars: 18 },
				{ op: "agent", id: "agent-success", status: "completed", durationMs: 1_200 },
			]
		: [
				{ op: "read", path: "/tmp/설정.json", chars: 12 },
				{ op: "write", path: "/tmp/결과.json", chars: 8 },
				{ op: "agent", id: "agent-error", status: "completed", durationMs: 700 },
			];
const details: EvalToolDetails = {
	language: "py",
	...(fixture === "success" ? { title: "load config" } : {}),
	durationMs: fixture === "success" ? 1_250 : 900,
	toolCalls: [],
	truncated: fixture === "error",
	...(fixture === "error" ? { isError: true } : {}),
	cells: [
		{
			index: 0,
			title: fixture === "success" ? "load config" : "실패 셀",
			code: input.code,
			language: "py",
			output:
				fixture === "success"
					? "loaded configuration"
					: "한글출력테스트와 아주 긴 오류 설명이 좁은 화면에서도 안전하게 줄바꿈되어야 합니다",
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
	...renderEvalResult(result, { expanded: false, isPartial: false }, undefined, resultContext).render(width),
];
const plainLines = rendered.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, ""));
for (const line of plainLines) console.log(line);
console.log(`MAXWIDTH:${Math.max(0, ...plainLines.map((line) => visibleWidth(line)))}`);
