import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalComponent } from "./eval-render-fixtures.ts";
import type { EvalToolCallSummary, EvalToolDetails } from "../src/tool/types.ts";
import { plainTheme, resultContext } from "./eval-render-fixtures.ts";

const STARTED_AT = 1_700_000_000_000;
const WIDTH = 80;

// Nested calls whose rows differ in height, as in senpi#6390's repro: some print one line, some a block.
function nestedCall(index: number): EvalToolCallSummary {
	const tall = index % 3 === 0;
	return {
		name: "bash",
		ok: true,
		callId: `call-${index}`,
		args: {
			command: tall
				? `gh search issues --repo storytold/repo${index} crash --limit 3 | cat`
				: `gh api repos/storytold/repo${index}`,
		},
		resultPreview: tall ? ["#1 crash one", "#2 crash two", "#3 crash three"].join("\n") : "{stars: 1}",
	};
}

function result(settled: number, status: "running" | "complete"): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: "" }],
		details: {
			language: "js",
			durationMs: 0,
			truncated: false,
			toolCalls: Array.from({ length: settled }, (_, index) => nestedCall(index)),
			cells: [{ index: 0, code: "await parallel(cmds)", language: "js", output: "", status, startedAt: STARTED_AT }],
		},
	};
}

function render(settled: number, status: "running" | "complete", last: EvalComponent | undefined, expanded = false) {
	const component = renderEvalResult(
		result(settled, status),
		{ expanded, isPartial: status === "running" },
		plainTheme(),
		{
			...resultContext({ lastComponent: last, now: STARTED_AT + 1_000, expanded }),
		},
	);
	return { component, height: component.render(WIDTH).length };
}

describe("eval nested calls keep a stable height while the cell runs (senpi#6390)", () => {
	it("Given nested calls of different heights sliding through the collapsed window, the running block never shrinks", () => {
		const heights: number[] = [];
		let last: EvalComponent | undefined;
		for (let settled = 1; settled <= 12; settled += 1) {
			const { component, height } = render(settled, "running", last);
			heights.push(height);
			last = component;
		}
		for (let index = 1; index < heights.length; index += 1)
			expect(heights[index], `heights ${heights.join(",")}`).toBeGreaterThanOrEqual(heights[index - 1] ?? 0);
	});

	it("Given a completed cell, the block returns to its natural height", () => {
		let last: EvalComponent | undefined;
		for (let settled = 1; settled <= 12; settled += 1) last = render(settled, "running", last).component;
		const done = render(12, "complete", last).height;
		expect(done).toBe(render(12, "complete", undefined).height);
	});

	it("Given the row is collapsed again after expanding, the floor from the expanded view does not stay", () => {
		let last = render(12, "running", undefined, true).component;
		last = render(12, "running", last, false).component;
		expect(last.render(WIDTH).length).toBe(render(12, "running", undefined, false).height);
	});
});
