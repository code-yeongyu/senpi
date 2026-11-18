import { describe, expect, it } from "vitest";
import { createToolCallMetric, recordToolCall, toolCallResultDetails } from "../src/tool/call-capture.ts";
import type { EvalToolCallSummary } from "../src/tool/types.ts";

// A nested call's details ride on its summary (persisted with the eval result) only so the tool's own renderResult can
// draw the row (oh-my-openagent#12994); the copy is plain JSON and bounded, never the live object.
describe("nested call details", () => {
	it("keeps a JSON copy of a tool result's details on the enriched summary", () => {
		const toolCalls: EvalToolCallSummary[] = [];
		const details = toolCallResultDetails({ content: [], details: { result: { kind: "ok", threads: [] } } });
		recordToolCall(
			toolCalls,
			true,
			{
				metric: createToolCallMetric("thread_list", 0),
				startedAt: 0,
				includeDetails: true,
				callId: "c-1",
				args: {},
			},
			undefined,
			undefined,
			details,
		);

		expect(toolCalls[0]?.details).toEqual({ result: { kind: "ok", threads: [] } });
	});

	it("drops details that are too large or not JSON", () => {
		expect(toolCallResultDetails({ content: [], details: { blob: "x".repeat(20_000) } })).toBeUndefined();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(toolCallResultDetails({ content: [], details: cyclic })).toBeUndefined();
		expect(toolCallResultDetails({ content: [], details: undefined })).toBeUndefined();
	});
});
