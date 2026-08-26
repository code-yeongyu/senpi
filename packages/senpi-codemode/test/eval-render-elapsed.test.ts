import { describe, expect, it, vi } from "vitest";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalCellResult, EvalToolDetails } from "../src/tool/types.ts";
import { evalResult, renderLines, resultContext, stripAnsi } from "./eval-render-fixtures.ts";

const STARTED_AT = 1_700_000_000_000;

function detailsWithCell(cell: Partial<EvalCellResult>): EvalToolDetails {
	return {
		language: "py",
		durationMs: 0,
		toolCalls: [],
		truncated: false,
		cells: [
			{
				index: 0,
				code: "print(1)",
				language: "py",
				output: "",
				status: "running",
				...cell,
			},
		],
	};
}

function headerFor(details: EvalToolDetails, now?: number): string {
	const rendered = renderLines(
		renderEvalResult(
			evalResult(details, "running"),
			{ expanded: false, isPartial: true },
			undefined,
			resultContext(now === undefined ? {} : { now }),
		),
	);
	return stripAnsi(rendered[0] ?? "");
}

describe("eval renderer live elapsed time", () => {
	it("derives a running cell's elapsed time from the injected clock, not the last update event", () => {
		const details = detailsWithCell({ status: "running", startedAt: STARTED_AT, durationMs: 0 });

		expect(headerFor(details, STARTED_AT + 13_000)).toContain("13s");
	});

	it("advances the displayed elapsed time as the injected clock advances", () => {
		const details = detailsWithCell({ status: "running", startedAt: STARTED_AT, durationMs: 0 });

		const early = headerFor(details, STARTED_AT + 4_000);
		const later = headerFor(details, STARTED_AT + 47_000);

		expect(early).toContain("4s");
		expect(later).toContain("47s");
		expect(early).not.toBe(later);
	});

	it.each(["pending", "detached"] as const)("ticks live for the non-terminal %s status", (status) => {
		const details = detailsWithCell({ status, startedAt: STARTED_AT, durationMs: 0 });

		expect(headerFor(details, STARTED_AT + 8_000)).toContain("8s");
	});

	it.each(["complete", "error", "cancelled"] as const)(
		"keeps the settled durationMs for the terminal %s status",
		(status) => {
			const details = detailsWithCell({ status, startedAt: STARTED_AT, durationMs: 2_000 });

			const header = headerFor(details, STARTED_AT + 900_000);

			expect(header).toContain("2s");
			expect(header).not.toContain("15m");
		},
	);

	it("renders byte-identically to the no-clock baseline when the cell has no startedAt", () => {
		const details = detailsWithCell({ status: "running", durationMs: 4_500 });

		expect(headerFor(details, STARTED_AT + 600_000)).toBe(headerFor(details));
	});
});

describe("eval renderer live elapsed repaint", () => {
	it("schedules repaints about once per second while the cell is non-terminal", () => {
		vi.useFakeTimers();
		try {
			const invalidate = vi.fn();
			const details = detailsWithCell({ status: "running", startedAt: STARTED_AT, durationMs: 0 });

			const component = renderEvalResult(
				evalResult(details, "running"),
				{ expanded: false, isPartial: true },
				undefined,
				resultContext({ invalidate, now: STARTED_AT }),
			);
			component.render(80);

			expect(invalidate).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1_000);
			expect(invalidate).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(2_000);
			expect(invalidate).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops repainting once the cell reaches a terminal status", () => {
		vi.useFakeTimers();
		try {
			const invalidate = vi.fn();
			const running = detailsWithCell({ status: "running", startedAt: STARTED_AT, durationMs: 0 });
			const component = renderEvalResult(
				evalResult(running, "running"),
				{ expanded: false, isPartial: true },
				undefined,
				resultContext({ invalidate, now: STARTED_AT }),
			);
			component.render(80);
			vi.advanceTimersByTime(1_000);
			const beforeTerminal = invalidate.mock.calls.length;

			const done = detailsWithCell({ status: "complete", startedAt: STARTED_AT, durationMs: 1_500 });
			const settled = renderEvalResult(
				evalResult(done, "done"),
				{ expanded: false, isPartial: false },
				undefined,
				resultContext({ invalidate, now: STARTED_AT + 1_500, lastComponent: component }),
			);
			settled.render(80);
			vi.advanceTimersByTime(10_000);

			expect(invalidate).toHaveBeenCalledTimes(beforeTerminal);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
