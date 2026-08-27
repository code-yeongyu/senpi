/**
 * QA driver: proves a RUNNING eval cell's header elapsed time advances between renders
 * of the SAME component, and that the repaint ticker stops once the cell settles.
 */
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalCellResult, EvalToolDetails } from "../src/tool/types.ts";

const STARTED_AT = Date.now();

function details(cell: Partial<EvalCellResult>): EvalToolDetails {
	return {
		language: "py",
		durationMs: 0,
		toolCalls: [],
		truncated: false,
		cells: [
			{
				index: 0,
				summary: "crunch the dataset",
				code: "run()",
				language: "py",
				output: "",
				status: "running",
				startedAt: STARTED_AT,
				...cell,
			},
		],
	};
}

type RenderContext = Parameters<typeof renderEvalResult>[3];

function context(now: number, invalidate: () => void, lastComponent?: ReturnType<typeof renderEvalResult>) {
	return {
		args: { language: "py", code: "run()", summary: "crunch the dataset" },
		toolCallId: "qa-live-elapsed",
		invalidate,
		lastComponent,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: false,
		imageProtocol: null,
		isError: false,
		now,
	} as unknown as RenderContext;
}

function header(lines: readonly string[]): string {
	return (lines[0] ?? "").replace(/\u001b\[[0-9;]*m/gu, "");
}

let repaints = 0;
const invalidate = (): void => {
	repaints += 1;
};

const running = details({});
const first = renderEvalResult({ content: [], details: running }, { expanded: false, isPartial: true }, undefined, context(STARTED_AT + 1_500, invalidate));
console.log(`render @ +1500ms : ${header(first.render(80))}`);

const second = renderEvalResult(
	{ content: [], details: running },
	{ expanded: false, isPartial: true },
	undefined,
	context(STARTED_AT + 2_600, invalidate, first),
);
console.log(`render @ +2600ms : ${header(second.render(80))}`);

const sameComponent = first === second;
console.log(`same component reused: ${sameComponent}`);

await new Promise((resolve) => setTimeout(resolve, 2_200));
console.log(`repaints requested while running: ${repaints} (expect >= 2)`);

const settled = details({ status: "complete", durationMs: 2_600 });
const done = renderEvalResult(
	{ content: [], details: settled },
	{ expanded: false, isPartial: false },
	undefined,
	context(STARTED_AT + 900_000, invalidate, second),
);
console.log(`render terminal    : ${header(done.render(80))}`);

const afterTerminal = repaints;
await new Promise((resolve) => setTimeout(resolve, 2_200));
console.log(`repaints after terminal render: ${repaints - afterTerminal} (expect 0 - ticker cleared)`);
