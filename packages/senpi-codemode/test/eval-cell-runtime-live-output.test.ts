import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_BYTES, truncateTailBytes } from "../src/output/streaming-output.ts";
import { CellResultBuilder, type CellState } from "../src/tool/cell-runtime.ts";
import { EvalOutputCollector } from "../src/tool/image.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";

const LIVE_UPDATE_LINES = 8;
/** Output-driven live updates are coalesced to one per this window (cell-runtime.ts). */
const OUTPUT_UPDATE_WINDOW_MS = 100;

type Update = Parameters<AgentToolUpdateCallback<EvalToolDetails>>[0];

function textOf(result: AgentToolResult<EvalToolDetails>): string {
	const part = result.content[0];
	return part !== undefined && part.type === "text" ? part.text : "";
}

function makeState(onUpdate?: (update: Update) => void): CellState {
	return {
		input: { language: "js", code: "print()", summary: "live window" },
		startedAt: Date.now(),
		signal: new AbortController().signal,
		onUpdate,
		toolCalls: [],
		toolCallMetrics: [],
		pendingBridgeCalls: [],
		statusEvents: [],
		active: true,
		output: "",
		phase: undefined,
		error: undefined,
		durationMs: 0,
		status: "pending",
	};
}

// The pre-#2262 live-text algorithm, kept verbatim as the equivalence oracle.
function referenceLiveText(stream: string, status: string): string {
	const aggregateOutput = truncateTailBytes(stream, DEFAULT_MAX_BYTES * 2).text;
	const outputLines = aggregateOutput.split("\n");
	const hasTrailingNewline = aggregateOutput.endsWith("\n");
	if (hasTrailingNewline) outputLines.pop();
	const output = `${outputLines.slice(-LIVE_UPDATE_LINES).join("\n")}${hasTrailingNewline ? "\n" : ""}`;
	return `1/1 cells ${status}\n[1] js live window ${status}${output.length === 0 ? "" : `\n${output}`}`;
}

function referenceCellTail(stream: string): string {
	return truncateTailBytes(stream, DEFAULT_MAX_BYTES * 2).text;
}

describe("cell result builder live output", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("streams live updates byte-identical to the aggregate-tail algorithm for every chunk", () => {
		// Given
		const chunkSequences: readonly string[][] = [
			["first\n", "second\n"],
			["no newline yet", "still no newline"],
			Array.from({ length: 12 }, (_, index) => `line-${index + 1}\n`),
			["a\r\n", "b\r", "\nc\r\n"],
			["multi\nline\nchunk\n", "tail"],
			[`${"x".repeat(70_000)}`, `${"y".repeat(70_000)}\n`, "small\n"],
			[`${"z".repeat(DEFAULT_MAX_BYTES * 2 + 500)}\n`, "after\n"],
			["", "empty\n", "", "chunks\n"],
		];
		for (const chunks of chunkSequences) {
			const updates: string[] = [];
			const state = makeState((update) => {
				const part = update.content[0];
				if (part.type === "text") updates.push(part.text);
			});
			const builder = new CellResultBuilder({ state, headBytes: 4096, maxColumns: 0, model: undefined });
			let stream = "";

			// When
			for (const chunk of chunks) {
				builder.push(chunk);
				stream += chunk;
				vi.advanceTimersByTime(OUTPUT_UPDATE_WINDOW_MS);

				// Then
				const expected = referenceLiveText(stream, "running");
				expect(updates.at(-1)).toBe(expected);
				expect(textOf(builder.liveResult())).toBe(expected);
			}
		}
	});

	it("keeps the cell tail in cells[0].output while streaming", () => {
		// Given
		const outputs: string[] = [];
		const state = makeState((update) => {
			const cellOutput = update.details.cells?.[0]?.output;
			if (cellOutput !== undefined) outputs.push(cellOutput);
		});
		const builder = new CellResultBuilder({ state, headBytes: 4096, maxColumns: 0, model: undefined });
		const chunks = Array.from({ length: 40 }, (_, index) => `line-${index}\n`);
		let stream = "";

		// When
		for (const chunk of chunks) {
			builder.push(chunk);
			stream += chunk;
			vi.advanceTimersByTime(OUTPUT_UPDATE_WINDOW_MS);

			// Then
			expect(outputs.at(-1)).toBe(referenceCellTail(stream));
		}
	});

	it("coalesces a burst of output into one live update per window and flushes the latest tail", () => {
		// Given
		const updates: string[] = [];
		const state = makeState((update) => {
			const part = update.content[0];
			if (part.type === "text") updates.push(part.text);
		});
		const builder = new CellResultBuilder({ state, headBytes: 4096, maxColumns: 0, model: undefined });
		const afterConstruction = updates.length;
		let stream = "";

		// When: 1,000 chunks arrive inside one window
		for (let index = 0; index < 1_000; index++) {
			const chunk = `line-${index}\n`;
			builder.push(chunk);
			stream += chunk;
		}
		const duringBurst = updates.length - afterConstruction;
		vi.advanceTimersByTime(OUTPUT_UPDATE_WINDOW_MS);

		// Then: at most the leading update fires inside the window, and the trailing one carries the latest tail
		expect(duringBurst).toBeLessThanOrEqual(1);
		expect(updates.length - afterConstruction).toBeLessThanOrEqual(2);
		expect(updates.at(-1)).toBe(referenceLiveText(stream, "running"));
	});

	it("serves the current tail from liveResult without waiting for the window", () => {
		// Given
		const state = makeState(() => {});
		const builder = new CellResultBuilder({ state, headBytes: 4096, maxColumns: 0, model: undefined });
		let stream = "";

		// When
		for (let index = 0; index < 20; index++) {
			const chunk = `row-${index}\n`;
			builder.push(chunk);
			stream += chunk;
		}
		const live = builder.liveResult();

		// Then
		expect(textOf(live)).toBe(referenceLiveText(stream, "running"));
		expect(live.details.cells?.[0]?.output).toBe(referenceCellTail(stream));
	});

	it("never asks the collector for whole-output text during streaming or finalization", async () => {
		// Given
		const aggregateText = vi.spyOn(EvalOutputCollector.prototype, "aggregateText");
		const updates: Update[] = [];
		const state = makeState((update) => updates.push(update));
		const builder = new CellResultBuilder({ state, headBytes: 4096, maxColumns: 0, model: undefined });

		// When
		for (let index = 0; index < 30; index++) builder.push(`chunk-${index}\n`);
		const final = await builder.finalize({ type: "result", cellId: "cell-1", ok: true, durationMs: 3 });

		// Then
		expect(aggregateText).not.toHaveBeenCalled();
		expect(updates.length).toBeGreaterThan(0);
		expect(textOf(final)).toContain("chunk-29");
		expect(final.details.cells?.[0]?.output).toContain("chunk-29");
	});

	it("finalizes with the same trimmed output as before", async () => {
		// Given
		const builder = new CellResultBuilder({
			state: makeState(),
			headBytes: 4096,
			maxColumns: 0,
			model: undefined,
		});

		// When
		builder.push("a\nb\n");
		const final: AgentToolResult<EvalToolDetails> = await builder.finalize({
			type: "result",
			cellId: "cell-2",
			ok: true,
			valueRepr: "42",
			durationMs: 5,
		});

		// Then
		expect(textOf(final)).toBe("a\nb\n42");
	});
});
