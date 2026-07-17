import type { AgentToolResult } from "@code-yeongyu/senpi";
import { initTheme, ToolExecutionComponent } from "@code-yeongyu/senpi";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";

// This test drives the REAL interactive ToolExecutionComponent — the exact component the TUI mux
// renders — through the pending -> running -> done lifecycle of an `eval` tool call. It is the
// regression guard for the duplicate-box bug: renderEvalCall and renderEvalResult each draw a full
// `╭─ ... ╰─` frame, and the renderer stacks call-then-result into one container, so once a result
// existed the TUI showed TWO stacked boxes (a stale "pending" frame above the live one).

type ToolDefParam = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
type ExecResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

const CODE = "d = {}\nd['favoriteModels'] = ['apitopia/kimi-k3']\nprint(d)";
const OUTPUT = "{'favoriteModels': ['apitopia/kimi-k3']}";

function countBoxes(lines: readonly string[]): number {
	return lines.filter((line) => line.includes("╭─")).length;
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/gu, "");
}

function evalToolDef(): ToolDefParam {
	return {
		name: "eval",
		label: "Eval",
		description: "eval",
		parameters: { type: "object" } as unknown as ToolDefParam["parameters"],
		execute: async () => ({ content: [] }),
		renderCall: renderEvalCall as unknown as ToolDefParam["renderCall"],
		renderResult: renderEvalResult as unknown as ToolDefParam["renderResult"],
	} as unknown as ToolDefParam;
}

function cellResult(status: "running" | "complete", output: string, durationMs: number): ExecResult {
	const details: EvalToolDetails = {
		language: "py",
		languages: ["py"],
		durationMs,
		toolCalls: [],
		truncated: false,
		phase: status === "complete" ? "complete" : "running",
		cells: [{ index: 0, code: CODE, language: "py", output, status, durationMs }],
	};
	const agentResult: AgentToolResult<EvalToolDetails> = { content: [{ type: "text", text: output }], details };
	return { ...agentResult, isError: false };
}

describe("eval ToolExecutionComponent lifecycle", () => {
	beforeAll(() => {
		initTheme();
	});

	it("Given the pending -> running -> done lifecycle then exactly one framed box renders at every state", () => {
		// Given the real interactive tool-execution component for an eval call
		const ui = { requestRender: () => {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"eval",
			"eval-1",
			{ language: "py", code: CODE },
			{},
			evalToolDef(),
			ui,
			"/tmp",
		);
		component.setArgsComplete();

		// When it is pending (no result yet), the call lane owns the single frame
		const pending = component.render(80);
		expect.soft(countBoxes(pending)).toBe(1);
		expect.soft(stripAnsi(pending.join("\n"))).toContain("pending");

		// When execution starts and streams a partial (running) result
		component.markExecutionStarted();
		component.updateResult(cellResult("running", "", 0), true);
		const running = component.render(80);
		const runningText = stripAnsi(running.join("\n"));
		expect.soft(countBoxes(running)).toBe(1); // was 2: a stale pending frame stacked above the running frame
		expect.soft(runningText).toContain("running");
		expect.soft(runningText).not.toContain("pending");

		// When the final result arrives
		component.updateResult(cellResult("complete", OUTPUT, 12), false);
		const done = component.render(80);
		const doneText = stripAnsi(done.join("\n"));
		expect.soft(countBoxes(done)).toBe(1); // was 2: a stale pending frame stacked above the done frame
		expect.soft(doneText).toContain("done");
		expect.soft(doneText).not.toContain("pending");
		expect.soft(doneText).not.toContain("running");
		expect.soft(doneText).toContain("favoriteModels");

		component.stopAnimation();
	});
});
