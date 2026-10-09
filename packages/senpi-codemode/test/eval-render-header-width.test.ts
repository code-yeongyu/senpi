import type { AgentToolResult } from "@code-yeongyu/senpi";
import { visibleWidth } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { renderEvalCall, renderEvalResult } from "../src/tool/render.ts";
import type { EvalCellResult, EvalToolDetails, EvalToolInput } from "../src/tool/types.ts";
import { callContext, plainTheme, resultContext, stripAnsi } from "./eval-render-fixtures.ts";

const STARTED_AT = 1_700_000_000_000;
const WIDTHS = [40, 50, 60, 80, 200] as const;
const ELAPSED_MS = [0, 900, 9_900, 10_000, 65_000, 3_660_000] as const;

function cellResult(cell: Partial<EvalCellResult>): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: "" }],
		details: {
			language: "js",
			durationMs: cell.durationMs ?? 0,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					code: "work();",
					language: "js",
					output: "",
					status: "running",
					...cell,
				},
			],
		},
	};
}

function renderThemedResult(
	result: AgentToolResult<EvalToolDetails>,
	options: { width: number; now?: number; args?: Partial<EvalToolInput> },
): string[] {
	return renderEvalResult(result, { expanded: false, isPartial: true }, plainTheme(), {
		...resultContext({
			args: { language: "js", code: "work();", summary: "fixture", ...options.args },
			...(options.now === undefined ? {} : { now: options.now }),
		}),
		spinnerFrame: 2,
	})
		.render(options.width)
		.map(stripAnsi);
}

function renderResult(
	result: AgentToolResult<EvalToolDetails>,
	options: { width: number; now?: number; args?: Partial<EvalToolInput> },
): string[] {
	const component = renderEvalResult(result, { expanded: false, isPartial: true }, plainTheme(), {
		...resultContext({
			args: { language: "js", code: "work();", summary: "fixture", ...options.args },
			...(options.now === undefined ? {} : { now: options.now }),
		}),
		spinnerFrame: 2,
	});
	return component.render(options.width).map(stripAnsi);
}

function renderStreamingCall(args: Parameters<typeof renderEvalCall>[0], width: number): string[] {
	return renderEvalCall(args, plainTheme(), {
		...callContext({ now: STARTED_AT }),
		spinnerFrame: 2,
	})
		.render(width)
		.map(stripAnsi);
}

describe("eval live header is always one row (senpi#2933 review HIGH-1)", () => {
	it.each(WIDTHS)("Given running with timeout 600 at %i cols then the header stays one row", async (width) => {
		const lines = renderResult(cellResult({ status: "running", startedAt: STARTED_AT, summary: "bounded run" }), {
			width,
			now: STARTED_AT + 5_000,
			args: { timeout: 600 },
		});
		// A wrapped header would still satisfy visibleWidth(lines[0]) and start row 2 with '│';
		// assert the rendered header ROW COUNT instead (review MEDIUM-4): the block is exactly
		// header + 6 body + border, so any wrap shows up as a longer array.
		expect(lines).toHaveLength(8);
		expect(lines[0]).toContain("running");
		expect(lines.at(-1)).toBe("╰─");
	});

	it.each(WIDTHS)(
		"Given running with reset and timeout at %i cols across elapsed values then the height is constant",
		(width) => {
			const heights = ELAPSED_MS.map((elapsed) => {
				const lines = renderResult(
					cellResult({ status: "running", startedAt: STARTED_AT, summary: "bounded run" }),
					{ width, now: STARTED_AT + elapsed, args: { reset: true, timeout: 30 } },
				);
				return lines.length;
			});
			// Assert the rendered row count (review MEDIUM-4): the block is exactly 8 rows, so a
			// wrapped header (or any growth) shows up here, at every elapsed value.
			expect(new Set(heights)).toEqual(new Set([8]));
		},
	);

	it.each(WIDTHS)("Given a queued cell waiting on the kernel at %i cols then the header is one row", async (width) => {
		const lines = renderResult(
			cellResult({ status: "queued", queuedBehind: [], summary: "queued run", startedAt: STARTED_AT }),
			{ width, now: STARTED_AT + 1_000 },
		);
		// Same wrap detector as the running cases (review MEDIUM-4): the block is header +
		// body + border, so a wrapped header grows the array.
		expect(lines).toHaveLength(8);
		expect(lines[0]).toContain("queued");
		expect(lines.at(-1)).toBe("╰─");
	});

	it.each(WIDTHS)("Given a queued cell behind another at %i cols then the header is one row", async (width) => {
		const lines = renderResult(
			cellResult({ status: "queued", queuedBehind: ["cell-17"], summary: "queued run", startedAt: STARTED_AT }),
			{ width, now: STARTED_AT + 1_000 },
		);
		expect(lines).toHaveLength(8);
		expect(lines.at(-1)).toBe("╰─");
	});

	it.each(WIDTHS)(
		"Given a streaming call with reset and timeout at %i cols then the header is one row",
		async (width) => {
			const lines = renderStreamingCall(
				{ language: "js", code: "work();", summary: "bounded run", reset: true, timeout: 30 },
				width,
			);
			expect(lines).toHaveLength(8);
			expect(lines.at(-1)).toBe("╰─");
		},
	);

	it("Given a done cell with badges at 40 cols then the row is exactly one line", async () => {
		const lines = renderResult(cellResult({ status: "complete", summary: "bounded run", durationMs: 3_660_000 }), {
			width: 40,
			args: { reset: true, timeout: 30 },
		});
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(40);
		expect(lines[0]).toContain("✓");
	});

	it("Given a running cell with a bounded status history when its live block renders then the stored omission count survives (senpi#2933 review HIGH-2)", async () => {
		const statusEvents = [
			{ op: "status-events-omitted", count: 19_901 },
			...Array.from({ length: 5 }, (_, index) => ({ op: "log", message: `status-${index + 1}` })),
		];
		const lines = renderResult(
			cellResult({ status: "running", startedAt: STARTED_AT, summary: "bounded", statusEvents }),
			{ width: 80, now: STARTED_AT + 1_000 },
		);
		const text = lines.join("\n");
		// The 3-row tail shows the section header, the fold marker and the newest event, so the
		// exact omission is the stored 19,901 plus the 4 sliced events.
		expect(text).toContain("19905 earlier status events");
		expect(text).toContain("status-5");
		expect(text).not.toContain("status-4");
	});

	it("Given a long headline at 40 cols with a badge then the headline is cut before elapsed drops (review MEDIUM-3)", async () => {
		// width 40 -> fitOneLine budget 37; the badge-less rest leaves a 13-cell headline budget,
		// so the floor-length cut headline and elapsed fit together when elapsed drops last.
		const summary = "count to twenty and then stop right there please";
		const lines = renderThemedResult(
			cellResult({
				status: "running",
				language: "js",
				runtime: { name: "bun", version: "1.3.1", path: "~/.bun/bin/bun" },
				summary,
				startedAt: STARTED_AT,
			}),
			{ width: 40, now: STARTED_AT + 1_000 },
		);
		expect(lines).toHaveLength(8);
		expect(lines[0]).toBe("╭─ ⠹ count to tw… · eval js running · 1s");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(40);
	});

	it("Given a very long summary at 40 cols then the summary keeps a readable remainder", async () => {
		const summary = "a".repeat(120);
		const lines = renderResult(cellResult({ status: "running", startedAt: STARTED_AT, summary }), {
			width: 40,
			now: STARTED_AT,
			args: { reset: true, timeout: 30 },
		});
		expect(lines[0]).toMatch(/a{4,}…/u);
	});
});
