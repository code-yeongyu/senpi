import type { AgentToolResult } from "@code-yeongyu/senpi";
import { visibleWidth } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalCellResult, EvalToolDetails } from "../src/tool/types.ts";
import { callContext, plainTheme, resultContext, stripAnsi } from "./eval-render-fixtures.ts";

const STARTED_AT = 1_700_000_000_000;

function cellResult(cell: Partial<EvalCellResult>, text = ""): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: {
			language: "js",
			durationMs: cell.durationMs ?? 0,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					code: "line1\nline2",
					language: "js",
					output: "",
					status: "running",
					...cell,
				},
			],
		},
	};
}

function renderResult(
	result: AgentToolResult<EvalToolDetails>,
	options: { expanded?: boolean; isPartial?: boolean; width?: number; now?: number; spinnerFrame?: number } = {},
): string[] {
	const component = renderEvalResult(
		result,
		{ expanded: options.expanded ?? false, isPartial: options.isPartial ?? true },
		plainTheme(),
		{
			...resultContext({
				args: { language: "js", code: "line1\nline2", summary: "fixture" },
				...(options.now === undefined ? {} : { now: options.now }),
			}),
			...(options.spinnerFrame === undefined ? {} : { spinnerFrame: options.spinnerFrame }),
		},
	);
	return component.render(options.width ?? 80).map(stripAnsi);
}

function renderCallStreaming(
	args: Parameters<typeof renderEvalCall>[0],
	options: { expanded?: boolean; width?: number; now?: number; spinnerFrame?: number } = {},
): string[] {
	const component = renderEvalCall(args, plainTheme(), {
		...callContext({
			...(options.expanded === undefined ? {} : { expanded: options.expanded }),
			...(options.now === undefined ? {} : { now: options.now }),
		}),
		...(options.spinnerFrame === undefined ? {} : { spinnerFrame: options.spinnerFrame }),
	});
	return component.render(options.width ?? 80).map(stripAnsi);
}

describe("eval live block: fixed-height streaming (senpi#2933)", () => {
	it.each([40, 80, 200])(
		"Given streaming code when rendered at %i columns then the block keeps a constant line count",
		(width) => {
			const lines = renderCallStreaming(
				{ language: "js", code: "const a = 1;\nconst b = 2;", summary: "stream two lines" },
				{ width, spinnerFrame: 0, now: STARTED_AT },
			);
			expect(lines).toHaveLength(8);
		},
	);

	it("Given code longer than the window when streaming then the newest line is visible and the marker is inside the height", async () => {
		const code = Array.from({ length: 20 }, (_, i) => `line-${i + 1}();`).join("\n");
		const lines = renderCallStreaming(
			{ language: "js", code, summary: "stream twenty lines" },
			{ width: 80, spinnerFrame: 0, now: STARTED_AT },
		);
		expect(lines).toHaveLength(8);
		const text = lines.join("\n");
		expect(text).toContain("line-20();");
		expect(text).not.toContain("line-1();");
		const marker = lines.findIndex((line) => line.includes("earlier code lines"));
		expect(marker).toBeGreaterThanOrEqual(1);
		expect(marker).toBeLessThan(7);
	});

	it("Given exactly window-length code when streaming then no earlier-lines marker appears", async () => {
		const code = Array.from({ length: 6 }, (_, i) => `row-${i + 1}`).join("\n");
		const lines = renderCallStreaming(
			{ language: "js", code, summary: "stream six rows" },
			{ width: 80, spinnerFrame: 0, now: STARTED_AT },
		);
		expect(lines).toHaveLength(8);
		expect(lines.join("\n")).not.toContain("earlier code lines");
	});

	it("Given more streamed lines when re-rendered then the height does not grow", async () => {
		const shortCode = "a();\nb();";
		const longCode = Array.from({ length: 12 }, (_, i) => `call-${i + 1}();`).join("\n");
		const short_ = renderCallStreaming(
			{ language: "js", code: shortCode, summary: "grow" },
			{ width: 80, spinnerFrame: 0, now: STARTED_AT },
		);
		const long_ = renderCallStreaming(
			{ language: "js", code: longCode, summary: "grow" },
			{ width: 80, spinnerFrame: 0, now: STARTED_AT },
		);
		expect(short_).toHaveLength(long_.length);
	});

	it("Given wrapping code at a narrow width then visual lines count toward the window", async () => {
		const code = `const longLine = "${"x".repeat(120)}";\nsecond();`;
		const lines = renderCallStreaming(
			{ language: "js", code, summary: "wrap" },
			{ width: 40, spinnerFrame: 0, now: STARTED_AT },
		);
		expect(lines).toHaveLength(8);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});

describe("eval live block: queued and running header (senpi#2933)", () => {
	it("Given a running cell when rendered then the block has the same fixed height as streaming", async () => {
		const code = Array.from({ length: 10 }, (_, i) => `work-${i + 1}();`).join("\n");
		const lines = renderResult(cellResult({ status: "running", code, startedAt: STARTED_AT }), {
			width: 80,
			now: STARTED_AT + 5_000,
			spinnerFrame: 2,
		});
		expect(lines).toHaveLength(8);
	});

	it("Given a running cell when the clock advances then spinner and elapsed advance with the height unchanged", async () => {
		const cell = { status: "running" as const, code: "spin();", startedAt: STARTED_AT };
		const early = renderResult(cellResult(cell), { width: 80, now: STARTED_AT + 2_000, spinnerFrame: 0 });
		const late = renderResult(cellResult(cell), { width: 80, now: STARTED_AT + 34_000, spinnerFrame: 5 });
		expect(early).toHaveLength(8);
		expect(late).toHaveLength(8);
		expect(early[0]).not.toBe(late[0]);
		expect(late[0]).toContain("34s");
	});

	it("Given a queued cell when rendered then the block shows a queued badge and keeps the fixed height", async () => {
		const lines = renderResult(
			cellResult({ status: "queued", code: "wait();", queuedBehind: [], startedAt: STARTED_AT }),
			{ width: 80, now: STARTED_AT + 1_000, spinnerFrame: 0 },
		);
		expect(lines).toHaveLength(8);
		expect(lines[0]).toContain("queued");
		expect(lines.join("\n")).toContain("wait();");
	});
});

describe("eval live block: one-line terminal rows (senpi#2933)", () => {
	it("Given a completed cell when rendered collapsed then it is exactly one line with icon summary status and duration", async () => {
		const lines = renderResult(
			cellResult({ status: "complete", summary: "tally rows", durationMs: 1_250, output: "ok" }),
			{ width: 80, isPartial: false },
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("✓");
		expect(lines[0]).toContain("tally rows");
		expect(lines[0]).toContain("done");
		expect(lines[0]).toContain("1s");
	});

	it("Given an errored cell when rendered collapsed then it is exactly one line with the error icon", async () => {
		const lines = renderResult(
			cellResult({ status: "error", summary: "broken step", durationMs: 900, output: "boom" }),
			{ width: 80, isPartial: false },
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("✗");
		expect(lines[0]).toContain("broken step");
		expect(lines[0]).toContain("error");
	});

	it("Given a cancelled cell when rendered collapsed then it is exactly one line", async () => {
		const lines = renderResult(cellResult({ status: "cancelled", summary: "stopped early", durationMs: 400 }), {
			width: 80,
			isPartial: false,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("×");
		expect(lines[0]).toContain("stopped early");
	});

	it("Given a completed cell when rendered expanded then the full code and output are shown", async () => {
		const code = Array.from({ length: 10 }, (_, i) => `full-code-${i + 1}();`).join("\n");
		const output = Array.from({ length: 6 }, (_, i) => `full-out-${i + 1}`).join("\n");
		const lines = renderResult(
			cellResult({ status: "complete", summary: "expandable", code, output, durationMs: 100 }),
			{ width: 80, isPartial: false, expanded: true },
		);
		const text = lines.join("\n");
		for (let i = 1; i <= 10; i++) expect(text).toContain(`full-code-${i}();`);
		for (let i = 1; i <= 6; i++) expect(text).toContain(`full-out-${i}`);
		expect(lines.length).toBeGreaterThan(8);
	});
});

describe("eval live block: constant total height with output and events (senpi#2933 review MEDIUM-2)", () => {
	it("Given streaming through running with output and status events then the total height is identical", async () => {
		const heights: number[] = [];
		// streaming, no output
		heights.push(
			renderCallStreaming(
				{ language: "js", code: "a();\nb();\nc();", summary: "grow" },
				{ width: 80, now: STARTED_AT },
			).length,
		);
		// running, no output
		heights.push(
			renderResult(cellResult({ status: "running", code: "a();", startedAt: STARTED_AT }), {
				width: 80,
				now: STARTED_AT + 1_000,
			}).length,
		);
		// running with 10 output lines
		heights.push(
			renderResult(
				cellResult({
					status: "running",
					code: "a();",
					startedAt: STARTED_AT,
					output: Array.from({ length: 10 }, (_, i) => `out-${i + 1}`).join("\n"),
				}),
				{ width: 80, now: STARTED_AT + 2_000 },
			).length,
		);
		// running with 3 status events
		heights.push(
			renderResult(
				cellResult({
					status: "running",
					code: "a();",
					startedAt: STARTED_AT,
					statusEvents: Array.from({ length: 3 }, (_, i) => ({ op: "log", message: `event-${i + 1}` })),
				}),
				{ width: 80, now: STARTED_AT + 3_000 },
			).length,
		);
		// running with output AND status events
		heights.push(
			renderResult(
				cellResult({
					status: "running",
					code: "a();",
					startedAt: STARTED_AT,
					output: "chunk 1\nchunk 2",
					statusEvents: [{ op: "log", message: "one" }],
				}),
				{ width: 80, now: STARTED_AT + 4_000 },
			).length,
		);
		expect(new Set(heights).size).toBe(1);
		expect(heights[0]).toBe(8);
	});
});

describe("eval live block: streaming header names the state (senpi#2933)", () => {
	it("Given a call still streaming when rendered then the header says streaming with the spinner and no elapsed", async () => {
		const lines = renderCallStreaming(
			{ language: "js", code: "const a = 1;\nconst b = 2;", summary: "stream two lines" },
			{ width: 80, spinnerFrame: 2, now: STARTED_AT + 5_000 },
		);
		expect(lines[0]).toContain("streaming");
		expect(lines[0]).toContain("⠹");
		expect(lines[0]).not.toContain("running");
		expect(lines[0]).not.toMatch(/· \d+s/u);
	});

	it("Given a call still streaming when the host gives no spinner frame then the header still says streaming (review MEDIUM-1)", async () => {
		// The host never supplies spinnerFrame for an eval call (no edit/write/task/progress
		// card), so the real CLI used to render 'pending'. The label comes from the call lane
		// itself: args complete, no result yet.
		const lines = renderCallStreaming(
			{ language: "js", code: "const a = 1;", summary: "stream one line" },
			{ width: 80, now: STARTED_AT },
		);
		expect(lines[0]).toContain("streaming");
		expect(lines[0]).not.toContain("pending");
	});

	it("Given a running cell when rendered then the header says running with elapsed", async () => {
		const lines = renderResult(cellResult({ status: "running", code: "work();", startedAt: STARTED_AT }), {
			width: 80,
			now: STARTED_AT + 3_000,
			spinnerFrame: 2,
		});
		expect(lines[0]).toContain("running");
		expect(lines[0]).toContain("3s");
		expect(lines[0]).not.toContain("streaming");
	});

	it("Given a streaming call when the host gives no spinner frame then the call lane arms its own ticker (review MEDIUM-5)", async () => {
		// The streaming block's spinner advances only if the call lane repaints itself; removing
		// the call-lane syncLiveTicker arm (mutation M5) must fail this contract.
		vi.useFakeTimers();
		try {
			const invalidate = vi.fn();
			renderEvalCall({ language: "js", code: "const a = 1;", summary: "stream" }, plainTheme(), {
				...callContext({ invalidate, now: STARTED_AT }),
				spinnerFrame: undefined,
			});
			vi.advanceTimersByTime(1_000);
			expect(invalidate).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("eval live block: partial-arg totality (senpi#2933)", () => {
	it("Given empty args when rendered then it never throws and never falls back to key=value", async () => {
		expect(() => renderCallStreaming({}, { width: 80, spinnerFrame: 0 })).not.toThrow();
		expect(() => renderCallStreaming({}, { width: 80 })).not.toThrow();
	});

	it("Given code-only args when rendered then it never throws", async () => {
		expect(() => renderCallStreaming({ code: "const a = 1;" }, { width: 80, spinnerFrame: 0 })).not.toThrow();
	});

	it("Given code and language args without a summary when rendered then it never throws", async () => {
		expect(() =>
			renderCallStreaming({ code: "const a = 1;", language: "js" }, { width: 80, spinnerFrame: 0 }),
		).not.toThrow();
	});
});
