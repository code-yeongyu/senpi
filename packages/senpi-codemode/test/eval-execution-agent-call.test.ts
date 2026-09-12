import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { RESERVED_AGENT_TOOL } from "../src/bridge/reserved.ts";
import type { AgentExecuteTool } from "../src/bridges/agent-bridge.ts";
import type { EvalExecutionEventPayload } from "../src/tool/eval-execution-event.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { ExecuteTool } from "../src/tool/types.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function withAvailability(executeTool: ExecuteTool): AgentExecuteTool {
	return Object.assign(executeTool, { isToolAvailable: (name: string) => name === "task" });
}

describe("eval execution agent-call metadata", () => {
	it("captures args and duration for the reserved agent bridge", async () => {
		const kernel = new FakeKernel([
			{
				type: "tool-call",
				callId: "agent-call-1",
				toolName: RESERVED_AGENT_TOOL,
				args: { prompt: "summarize x", agent: "reviewer" },
			},
			result("agent-cell", "done"),
		]);
		const executeTool = withAvailability(async () =>
			textResult("FAKE_RESULT", { task_id: "st_agent", status: "completed" }),
		);
		const emissions: EvalExecutionEventPayload[] = [];
		const tool = createEvalTool({
			enabledLanguages: { py: false, js: true, rb: false, jl: false },
			kernelManager: new FakeManager([["js", kernel]]),
			cellTimeoutSeconds: 30,
			executeTool,
			onCellSettled: (payload) => emissions.push(payload),
		});

		await tool.execute(
			"agent-cell",
			{ language: "js", code: "await agent('summarize x')", summary: "spawn summarizer" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		expect(emissions).toHaveLength(1);
		expect(emissions[0]?.toolCalls).toEqual([
			expect.objectContaining({
				name: RESERVED_AGENT_TOOL,
				ok: true,
				callId: "agent-call-1",
				args: { prompt: "summarize x", agent: "reviewer" },
				durationMs: expect.any(Number),
			}),
		]);
		expect(emissions[0]?.toolAggregates[RESERVED_AGENT_TOOL]).toEqual({
			count: 1,
			totalDurationMs: expect.any(Number),
			okCount: 1,
			errorCount: 0,
			pendingCount: 0,
		});
	});
});
