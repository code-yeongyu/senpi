import { describe, expect, it } from "vitest";
import { CellResultBuilder, type CellState } from "../src/tool/cell-runtime.ts";

const STARTED_AT = 1_700_000_000_000;

function makeState(): CellState {
	return {
		input: { language: "py", code: "1", summary: "startedAt propagation" },
		startedAt: STARTED_AT,
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
	};
}

function makeBuilder(state: CellState): CellResultBuilder {
	return new CellResultBuilder({ state, headBytes: 4096, maxColumns: 120, model: undefined });
}

describe("cell result startedAt propagation", () => {
	it("stamps the live cell payload with the cell start time so renderers can tick", () => {
		const builder = makeBuilder(makeState());

		const live = builder.liveResult();

		expect(live.details.cells?.[0]?.startedAt).toBe(STARTED_AT);
	});

	it("keeps startedAt on the settled cell payload for RPC consumers", async () => {
		const builder = makeBuilder(makeState());

		const result = await builder.finalize({ type: "result", cellId: "cell-1", ok: true, durationMs: 5 });

		expect(result.details.cells?.[0]?.startedAt).toBe(STARTED_AT);
		expect(result.details.cells?.[0]?.durationMs).toBe(5);
	});
});
