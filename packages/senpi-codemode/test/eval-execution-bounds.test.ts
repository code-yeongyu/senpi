import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { EvalExecutionEventPayload } from "../src/tool/eval-execution-event.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";

function textResult(): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: "ok" }], details: {} };
}

describe("eval execution event bounds", () => {
	it("caps aggregate names and preserves overflow totals", async () => {
		const messages: KernelToHostMessage[] = [];
		for (let index = 0; index < 70; index += 1) {
			messages.push({
				type: "tool-call",
				callId: `call-${index}`,
				toolName: `${index}-${"x".repeat(200)}`,
				args: {},
			});
		}
		messages.push(result("bounded-cell", "done"));
		const emissions: EvalExecutionEventPayload[] = [];
		const tool = createEvalTool({
			enabledLanguages: { py: false, js: true, rb: false, jl: false },
			kernelManager: new FakeManager([["js", new FakeKernel(messages)]]),
			cellTimeoutSeconds: 30,
			executeTool: async () => textResult(),
			onCellSettled: (payload) => emissions.push(payload),
		});

		await tool.execute(
			"bounded-cell",
			{ language: "js", code: "many distinct calls", summary: "bound aggregate names" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		const payload = emissions[0];
		expect(payload?.toolCallCount).toBe(70);
		expect(payload?.distinctToolsCalled).toHaveLength(64);
		expect(Object.keys(payload?.toolAggregates ?? {})).toHaveLength(64);
		expect(payload?.toolAggregatesTruncated).toBe(true);
		expect(payload?.toolAggregateOverflow).toMatchObject({ count: 6 });
		expect(payload?.distinctToolsCalled.every((name) => [...name].length <= 129)).toBe(true);
	});
});
