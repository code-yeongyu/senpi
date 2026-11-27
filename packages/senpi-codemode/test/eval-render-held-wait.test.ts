import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { holdCellWait, releaseCellWait } from "../src/tool/held-cell-waits.ts";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { plainTheme, resultContext, stripAnsi } from "./eval-render-fixtures.ts";

const CELL = "held-row";
const SCAN = "reading the workspace's files before the js kernel runs it";
const KERNEL = "waiting for the js kernel to be ready";

afterEach(() => {
	releaseCellWait(CELL);
	vi.useRealTimers();
});

function queuedRow(queuedBehind: readonly string[] = []): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: KERNEL }],
		details: {
			language: "js",
			durationMs: 0,
			toolCalls: [],
			truncated: false,
			cells: [{ index: 0, code: "await work()", language: "js", output: "", status: "queued", queuedBehind }],
		},
	};
}

function renderRow(invalidate: () => void, queuedBehind: readonly string[] = []) {
	return renderEvalResult(queuedRow(queuedBehind), { expanded: false, isPartial: true }, plainTheme(), {
		...resultContext({ invalidate }),
		toolCallId: CELL,
	});
}

describe("the live row of a cell the workspace scan holds (senpi#7535)", () => {
	it("names the scan while the wait is held and the kernel wording once it is released, with no new result", () => {
		const component = renderRow(() => {});
		holdCellWait(CELL, "workspace");
		const held = component.render(200).map(stripAnsi).join("\n");
		releaseCellWait(CELL);
		const released = component.render(200).map(stripAnsi).join("\n");

		expect(held).toContain(SCAN);
		expect(released).toContain(KERNEL);
		expect(released).not.toContain(SCAN);
	});

	it("repaints a first-in-line queued row by itself, so a wait held after its last update shows, and not a row queued behind another", () => {
		vi.useFakeTimers();
		const behind = vi.fn();
		renderRow(behind, ["earlier-cell"]);
		vi.advanceTimersByTime(1_000);
		expect(behind).not.toHaveBeenCalled();

		const firstInLine = vi.fn();
		const component = renderRow(firstInLine);
		holdCellWait(CELL, "workspace");
		vi.advanceTimersByTime(1_000);
		expect(firstInLine).toHaveBeenCalled();
		expect(component.render(200).map(stripAnsi).join("\n")).toContain(SCAN);
	});
});
