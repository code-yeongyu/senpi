import { describe, expect, it } from "vitest";
import { CellResultBuilder, type CellState } from "../src/tool/cell-runtime.ts";
import type { EvalRuntimeInfo } from "../src/tool/types.ts";

function makeState(runtime?: EvalRuntimeInfo): CellState {
	return {
		input: { language: "py", code: "1", summary: "runtime propagation" },
		startedAt: Date.now(),
		signal: new AbortController().signal,
		onUpdate: undefined,
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
		...(runtime === undefined ? {} : { runtime }),
	};
}

function makeBuilder(state: CellState): CellResultBuilder {
	return new CellResultBuilder({ state, headBytes: 4096, maxColumns: 120, model: undefined });
}

describe("cell result runtime propagation", () => {
	it("carries the kernel runtime into details and the RPC cell payload", async () => {
		const runtime: EvalRuntimeInfo = { name: "python", version: "3.14.7", path: "/opt/homebrew/bin/python3" };
		const builder = makeBuilder(makeState(runtime));

		const result = await builder.finalize({ type: "result", cellId: "cell-1", ok: true, durationMs: 5 });

		expect(result.details.runtime).toEqual(runtime);
		expect(result.details.cells?.[0]?.runtime).toEqual(runtime);
	});

	it("omits runtime from details when the kernel identity is unknown", async () => {
		const builder = makeBuilder(makeState());

		const result = await builder.finalize({ type: "result", cellId: "cell-2", ok: true, durationMs: 5 });

		expect(result.details.runtime).toBeUndefined();
		expect(result.details.cells?.[0]).not.toHaveProperty("runtime");
	});
});
