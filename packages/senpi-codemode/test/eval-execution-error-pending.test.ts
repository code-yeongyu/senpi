import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import type { EvalExecutionEventPayload } from "../src/tool/eval-execution-event.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { errorResult, FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";

describe("eval execution pending-call accounting", () => {
	it("counts an initiated bridge call when an error cell settles before the call", async () => {
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "pending-read", toolName: "read", args: { path: "slow.txt" } },
			errorResult("error-cell", "cell failed first"),
		]);
		const pending = new Promise<AgentToolResult<unknown>>(() => {});
		const emissions: EvalExecutionEventPayload[] = [];
		const tool = createEvalTool({
			enabledLanguages: { py: false, js: true, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool: async () => await pending,
			onCellSettled: (payload) => emissions.push(payload),
		});

		await tool.execute(
			"error-cell",
			{ language: "js", code: "tool.read({ path: 'slow.txt' })", summary: "pending bridge" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(emissions).toHaveLength(1);
		expect(emissions[0]).toMatchObject({
			ok: false,
			toolCallCount: 1,
			pendingToolCallCount: 1,
			toolAggregates: {
				read: {
					count: 1,
					totalDurationMs: expect.any(Number),
					okCount: 0,
					errorCount: 0,
					pendingCount: 1,
				},
			},
		});
	});
});
