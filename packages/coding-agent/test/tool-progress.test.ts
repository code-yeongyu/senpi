import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	formatToolProgressLine,
	readToolProgress,
	type ToolProgressDetails,
} from "../src/modes/interactive/tool-progress.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(requestRender = vi.fn()): { tui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	return {
		tui: { requestRender } as unknown as TUI,
		requestRender,
	};
}

function createToolDefinition(name: string, renderResult?: ToolDefinition["renderResult"]): ToolDefinition {
	return {
		name,
		label: name,
		description: "test tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: undefined }),
		renderResult,
	};
}

function progressDetails(progress: ToolProgressDetails): { progress: ToolProgressDetails } {
	return { progress };
}

describe("tool progress", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("reads duck-typed progress details and formats elapsed progress", () => {
		const progress = { activity: "waiting for /BUILD OK/", startedAt: 1_000, maxWaitMs: 300_000 };
		expect(readToolProgress(progressDetails(progress))).toEqual(progress);
		expect(readToolProgress({ progress: { startedAt: "soon" } })).toBeUndefined();
		expect(readToolProgress(null)).toBeUndefined();

		expect(formatToolProgressLine({ startedAt: 1_000 }, 13_900)).toBe("⠋ working · 12s");
		expect(formatToolProgressLine({ activity: "waiting", startedAt: 1_000 }, 68_000)).toBe("⠋ waiting · 1m 07s");
		expect(formatToolProgressLine(progress, 13_900, 0)).toBe("⠋ waiting for /BUILD OK/ · 12s / max 300s");
		expect(formatToolProgressLine(progress, 13_900, 4)).toBe("⠼ waiting for /BUILD OK/ · 12s / max 300s");
	});

	test("renders the progress line for fallback and custom renderer shells, then removes it on final result", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(13_900));
		try {
			const details = progressDetails({ activity: "waiting for /BUILD OK/", startedAt: 1_000, maxWaitMs: 300_000 });
			const fallback = new ToolExecutionComponent(
				"progress_fallback",
				"fallback-progress",
				{},
				{},
				undefined,
				createFakeTui().tui,
				process.cwd(),
			);
			fallback.updateResult({ content: [{ type: "text", text: "partial output" }], details, isError: false }, true);
			expect(stripAnsi(fallback.render(120).join("\n"))).toContain("⠋ waiting for /BUILD OK/ · 12s / max 300s");

			const custom = new ToolExecutionComponent(
				"progress_custom",
				"custom-progress",
				{},
				{},
				createToolDefinition("progress_custom", () => new Text("custom result", 0, 0)),
				createFakeTui().tui,
				process.cwd(),
			);
			custom.updateResult({ content: [{ type: "text", text: "partial output" }], details, isError: false }, true);
			const partial = stripAnsi(custom.render(120).join("\n"));
			expect(partial).toContain("custom result");
			expect(partial).toContain("⠋ waiting for /BUILD OK/ · 12s / max 300s");

			custom.updateResult({ content: [{ type: "text", text: "complete" }], details, isError: false });
			const final = stripAnsi(custom.render(120).join("\n"));
			expect(final).toContain("custom result");
			expect(final).not.toContain("waiting for /BUILD OK/");
		} finally {
			vi.useRealTimers();
		}
	});

	test("ticks partial progress locally and stops when the final result arrives", () => {
		vi.useFakeTimers();
		try {
			const { tui, requestRender } = createFakeTui();
			const component = new ToolExecutionComponent(
				"progress_ticker",
				"ticker-progress",
				{},
				{},
				undefined,
				tui,
				process.cwd(),
			);
			component.updateResult(
				{
					content: [],
					details: progressDetails({ activity: "waiting", startedAt: Date.now() }),
					isError: false,
				},
				true,
			);

			expect(stripAnsi(component.render(120).join("\n"))).toContain("⠋ waiting · 0s");
			vi.advanceTimersByTime(80);
			expect(requestRender).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(80);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("⠙ waiting · 0s");

			component.updateResult({ content: [], details: {}, isError: false });
			requestRender.mockClear();
			vi.advanceTimersByTime(160);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
