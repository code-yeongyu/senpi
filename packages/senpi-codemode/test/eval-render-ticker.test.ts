import { afterEach, describe, expect, it, vi } from "vitest";
import { renderEvalResult } from "../src/tool/render.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { evalResult, renderLines, resultContext } from "./eval-render-fixtures.ts";

const T0 = 1_000_000;

function detailsWithStatus(status: "running" | "detached" | "complete"): EvalToolDetails {
	return {
		language: "js",
		languages: ["js"],
		summary: "ticker contract",
		durationMs: 1_000,
		toolCalls: [],
		truncated: false,
		cells: [
			{
				index: 0,
				summary: "ticker",
				code: "1",
				language: "js",
				output: "",
				status,
				startedAt: T0,
				durationMs: 1_000,
			},
		],
	};
}

describe("eval result live ticker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not arm the repaint ticker for a detached cell card", () => {
		vi.useFakeTimers();
		renderEvalResult(
			evalResult(detailsWithStatus("detached"), "detached"),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ now: T0 }),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not arm the repaint ticker for a terminal cell card", () => {
		vi.useFakeTimers();
		renderEvalResult(
			evalResult(detailsWithStatus("complete"), "done"),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ now: T0 }),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("arms the ticker for a running cell and stops it on the terminal re-render", () => {
		vi.useFakeTimers();
		const component = renderEvalResult(
			evalResult(detailsWithStatus("running"), "running"),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ now: T0 }),
		);
		expect(vi.getTimerCount()).toBe(1);
		renderEvalResult(
			evalResult(detailsWithStatus("complete"), "done"),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ now: T0, lastComponent: component }),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops the ticker when the row stops rendering, and rearms on the next render", () => {
		vi.useFakeTimers();
		const component = renderEvalResult(
			evalResult(detailsWithStatus("running"), "running"),
			{ expanded: false, isPartial: false },
			undefined,
			resultContext({ now: T0 }),
		);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(61_000);
		expect(vi.getTimerCount()).toBe(0);
		renderLines(component);
		expect(vi.getTimerCount()).toBe(1);
	});
});
