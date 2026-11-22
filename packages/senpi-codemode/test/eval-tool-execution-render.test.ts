import type { AgentToolResult } from "@code-yeongyu/senpi";
import { initTheme, ToolExecutionComponent } from "@code-yeongyu/senpi";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

// This test drives the REAL interactive ToolExecutionComponent — the exact component the TUI mux
// renders — through the pending -> running -> done lifecycle of an `eval` tool call. It is the
// regression guard for the duplicate-box bug: renderEvalCall and renderEvalResult each draw a full
// `╭─ ... ╰─` frame, and the renderer stacks call-then-result into one container, so once a result
// existed the TUI showed TWO stacked boxes (a stale "pending" frame above the live one).

type ToolDefParam = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
type ExecResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

/** A real TUI over an in-memory terminal: the component renders against the same object the TUI mux uses. */
async function renderOnlyTui(): Promise<TUI> {
	const { VirtualTerminal } = await import("../../tui/test/virtual-terminal.ts");
	return new TUI(new VirtualTerminal(80, 24));
}

const CODE = "d = {}\nd['favoriteModels'] = ['apitopia/kimi-k3']\nprint(d)";
const OUTPUT = "{'favoriteModels': ['apitopia/kimi-k3']}";

/** Each eval row starts with one lead-in: `╭─` for a framed row, `╶─` for a one-line live row (senpi#2802). */
function countBoxes(lines: readonly string[]): number {
	return lines.filter((line) => line.includes("╭─") || line.includes("╶─")).length;
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/gu, "");
}

function evalToolDef(): ToolDefParam {
	return {
		name: "eval",
		label: "Eval",
		description: "eval",
		parameters: { type: "object" },
		execute: async () => ({ content: [], details: undefined }),
		renderCall: renderEvalCall,
		renderResult: renderEvalResult,
	};
}

function cellResult(status: "running" | "complete", output: string, durationMs: number, summary?: string): ExecResult {
	const label = summary === undefined ? {} : { summary };
	const details: EvalToolDetails = {
		language: "py",
		languages: ["py"],
		...label,
		durationMs,
		toolCalls: [],
		truncated: false,
		phase: status === "complete" ? "complete" : "running",
		cells: [{ index: 0, ...label, code: CODE, language: "py", output, status, durationMs }],
	};
	const agentResult: AgentToolResult<EvalToolDetails> = { content: [{ type: "text", text: output }], details };
	return { ...agentResult, isError: false };
}

describe("eval ToolExecutionComponent lifecycle", () => {
	beforeAll(() => {
		initTheme();
	});

	it("Given the pending -> running -> done lifecycle then exactly one framed box renders at every state", async () => {
		// Given the real interactive tool-execution component for an eval call
		const ui = await renderOnlyTui();
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

		// When it has no result yet, the call lane owns the single streaming frame
		const pending = component.render(80);
		expect.soft(countBoxes(pending)).toBe(1);
		expect.soft(stripAnsi(pending.join("\n"))).toContain("streaming");

		// When execution starts and streams a partial (running) result
		component.markExecutionStarted();
		component.updateResult(cellResult("running", "", 0), true);
		const running = component.render(80);
		const runningText = stripAnsi(running.join("\n"));
		expect.soft(countBoxes(running)).toBe(1); // was 2: a stale pending frame stacked above the running frame
		expect.soft(runningText).toContain("running");
		expect.soft(runningText).not.toContain("pending");

		// When the final result arrives, the collapsed row is the one-line terminal summary (senpi#2933)
		component.updateResult(cellResult("complete", OUTPUT, 12), false);
		const done = component.render(80);
		const doneText = stripAnsi(done.join("\n"));
		const doneRows = done.map(stripAnsi).filter((line) => line.includes("eval py done"));
		expect.soft(countBoxes(done)).toBe(1); // was 2: a stale pending frame stacked above the done frame
		expect.soft(doneRows).toHaveLength(1);
		expect.soft(doneRows[0]).toMatch(/╶─ ✓/u);
		expect.soft(doneText).not.toContain("pending");
		expect.soft(doneText).not.toContain("running");
		expect.soft(doneText).not.toContain("favoriteModels");

		// When the row expands, the full output returns
		component.setExpanded(true);
		const expandedText = stripAnsi(component.render(80).join("\n"));
		expect.soft(expandedText).toContain("favoriteModels");

		component.stopAnimation();
	});
});

function nestedWidgetResult(): ExecResult {
	const details: EvalToolDetails = {
		language: "py",
		languages: ["py"],
		durationMs: 12,
		toolCalls: [
			{
				name: "read",
				ok: true,
				callId: "read-1",
				args: { path: "/tmp/config.json" },
				durationMs: 12,
				resultPreview: "loaded configuration",
			},
		],
		truncated: false,
		phase: "complete",
		cells: [{ index: 0, code: CODE, language: "py", output: OUTPUT, status: "complete", durationMs: 12 }],
	};
	const agentResult: AgentToolResult<EvalToolDetails> = { content: [{ type: "text", text: OUTPUT }], details };
	return { ...agentResult, isError: false };
}

describe("nested tool-call widgets in ToolExecutionComponent", () => {
	beforeAll(() => {
		initTheme();
	});

	it("nested widgets: single box", async () => {
		const { TUI } = await import("@earendil-works/pi-tui");
		const { VirtualTerminal } = await import("../../tui/test/virtual-terminal.ts");
		const ui = new TUI(new VirtualTerminal(80, 24));
		const component = new ToolExecutionComponent(
			"eval",
			"eval-nested-read",
			{ language: "py", code: CODE },
			{},
			evalToolDef(),
			ui,
			"/tmp",
		);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult(nestedWidgetResult(), false);

		const lines = component.render(80);
		const output = stripAnsi(lines.join("\n"));
		expect(countBoxes(lines)).toBe(1);
		expect(output).toContain("config.json");

		component.stopAnimation();
	});
});

describe("eval summary in transcript frames", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function summaryComponent(): Promise<ToolExecutionComponent> {
		const ui = await renderOnlyTui();
		const component = new ToolExecutionComponent(
			"eval",
			"eval-summary",
			{ language: "py", code: CODE, summary: "collect progress" },
			{},
			evalToolDef(),
			ui,
			"/tmp",
		);
		component.setArgsComplete();
		return component;
	}

	function expectSummaryHeadline(lines: readonly string[], status: string): void {
		const plain = lines.map(stripAnsi);
		const headerIndex = plain.findIndex((line) => line.includes("eval py"));
		expect(headerIndex).toBeGreaterThanOrEqual(0);
		expect.soft(plain[headerIndex]).toMatch(new RegExp(`[╭╶]─ \\S collect progress · eval py ${status}`, "u"));
		expect.soft(plain.filter((line) => line.includes("collect progress"))).toHaveLength(1);
	}

	it("Given a running eval with a summary when the frame renders then the header leads with the summary (senpi#2802)", async () => {
		// Given the real interactive component streaming a running result whose cell carries a summary
		const component = await summaryComponent();
		component.markExecutionStarted();
		component.updateResult(cellResult("running", "", 0, "collect progress"), true);

		// When the running frame renders
		const lines = component.render(80);

		// Then the header leads with the summary, shown once
		expectSummaryHeadline(lines, "running");
		component.stopAnimation();
	});

	it("Given a completed eval with a summary when the result row renders then the one-line row carries the summary (senpi#2933)", async () => {
		// Given the real interactive component receiving its final result
		const component = await summaryComponent();
		component.markExecutionStarted();
		component.updateResult(cellResult("complete", OUTPUT, 12, "collect progress"), false);

		// When the done row renders
		const lines = component.render(80);

		// Then the collapsed terminal row is one line leading with the summary
		const plain = lines.map(stripAnsi);
		const doneRows = plain.filter((line) => line.includes("eval py done"));
		expect.soft(doneRows).toHaveLength(1);
		expect.soft(doneRows[0]).toMatch(/╶─ ✓ collect progress · eval py done/u);
		component.stopAnimation();
	});

	it("Given a six-line cell with a summary when collapsed and expanded then the one-line row and the full code render (senpi#2933)", () => {
		// Given a finished cell whose code overflows the collapsed preview budget
		const codeLines = ["a = 1", "b = 2", "c = 3", "d = 4", "e = 5", "f = 6"];
		const details: EvalToolDetails = {
			language: "py",
			languages: ["py"],
			summary: "tally rows",
			durationMs: 7,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					summary: "tally rows",
					code: codeLines.join("\n"),
					language: "py",
					output: "done",
					status: "complete",
					durationMs: 7,
				},
			],
		};
		const givenResult: AgentToolResult<EvalToolDetails> = {
			content: [{ type: "text", text: "done" }],
			details,
		};

		// When the result renders collapsed and expanded
		const collapsed = renderEvalResult(givenResult, { expanded: false, isPartial: false }, undefined, {
			args: { language: "py", code: codeLines.join("\n"), summary: "tally rows" },
			toolCallId: "eval-summary-collapsed",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: "/tmp",
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			imageProtocol: null,
			isError: false,
		}).render(80);
		const expanded = renderEvalResult(givenResult, { expanded: true, isPartial: false }, undefined, {
			args: { language: "py", code: codeLines.join("\n"), summary: "tally rows" },
			toolCallId: "eval-summary-expanded",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: "/tmp",
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: true,
			showImages: false,
			imageProtocol: null,
			isError: false,
		}).render(80);

		// Then the collapsed row is one line with the summary headline; expanded shows the full code
		const collapsedText = collapsed.join("\n");
		const expandedText = expanded.join("\n");
		expect.soft(collapsed).toHaveLength(1);
		expect.soft(collapsedText).toContain("tally rows");
		expect.soft(collapsedText).toContain("eval py done");
		for (const codeLine of codeLines) expect.soft(collapsedText).not.toContain(codeLine);
		expect.soft(expandedText).toContain("tally rows");
		for (const codeLine of codeLines) expect.soft(expandedText).toContain(codeLine);
	});

	it("Given a detached cell with a summary when peeked live and terminal then both results carry the summary", async () => {
		// Given a js cell that detaches on timeout (style of eval-detached-peek's rich-cell flow)
		vi.useFakeTimers();
		const manager = new EvalDetachedCellManager();
		const kernel = new FakeKernel([]);
		const tool = createEvalTool({
			enabledLanguages: { js: true, py: false, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 1,
			executeTool: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			cellManager: manager,
		});
		const interactive = { ...fakeExtensionContext(), mode: "tui" as const };
		const started = kernel.deferNextRun();
		const execution = tool.execute(
			"summary-cell",
			{ language: "js", code: "await new Promise(() => {})", summary: "collect progress", on_timeout: "detach" },
			undefined,
			undefined,
			interactive,
		);
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		await execution;

		// When the still-running detached cell is peeked
		const live = await tool.execute(
			"peek-live",
			{ action: "peek", cell_id: "summary-cell" },
			undefined,
			undefined,
			interactive,
		);

		// Then the live peek result carries the summary on the details and the cell
		expect.soft(live.details.summary).toBe("collect progress");
		expect.soft(live.details.cells?.[0]?.status).toBe("detached");
		expect.soft(live.details.cells?.[0]?.summary).toBe("collect progress");

		// When the kernel run completes and the terminal snapshot is peeked
		kernel.completeDeferredRun(result("summary-cell", "done", 5));
		await manager.waitForTerminal("summary-cell");
		const terminal = await tool.execute(
			"peek-terminal",
			{ action: "peek", cell_id: "summary-cell" },
			undefined,
			undefined,
			interactive,
		);

		// Then the terminal peek result still carries the summary
		expect.soft(terminal.details.summary).toBe("collect progress");
		expect.soft(terminal.details.cells?.[0]?.status).toBe("complete");
		expect.soft(terminal.details.cells?.[0]?.summary).toBe("collect progress");

		await manager.flushNotifications();
	});
});
