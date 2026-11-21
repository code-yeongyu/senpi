import type { AgentToolResult, ExecutionPipelineWitness } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("nested ctx.executeTool on the session's ToolHost", () => {
	it("runs the nested body on the prepared pipeline with the caller's signal and updates, and records its witness", async () => {
		const callerSignal = new AbortController().signal;
		const bodyCalls: { toolCallId: string; signal: AbortSignal | undefined }[] = [];
		const updates: AgentToolResult<unknown>[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "probe",
						label: "Probe",
						description: "Echoes its value",
						parameters: Type.Object({ value: Type.String() }),
						exposure: "codemode",
						execute: async (toolCallId, { value }, signal, onUpdate) => {
							bodyCalls.push({ toolCallId, signal });
							onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} });
							return { content: [{ type: "text", text: value }], details: {} };
						},
					});
					pi.registerTool({
						name: "outer",
						label: "Outer",
						description: "Calls probe",
						parameters: Type.Object({}),
						exposure: "model-only",
						execute: async (_id, _params, _signal, _onUpdate, ctx) => {
							const nested = await ctx.executeTool(
								"probe",
								{ value: "ran" },
								{ signal: callerSignal, onUpdate: (partial) => updates.push(partial) },
							);
							return { content: nested.result.content, details: {} };
						},
					});
				},
			],
		});
		const witnesses: ExecutionPipelineWitness[] = [];
		harness.agent.onExecutionPipeline = (witness) => {
			witnesses.push(witness);
		};

		try {
			await harness.session.bindExtensions({});
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("outer", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");

			const result = harness.session.messages.find(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);
			if (!result) throw new Error("No tool result");
			const nestedId = `${result.toolCallId}/1`;
			expect(result.content).toEqual([{ type: "text", text: "ran" }]);
			expect(bodyCalls.map((call) => call.toolCallId)).toEqual([nestedId]);
			expect(bodyCalls[0]?.signal).toBe(callerSignal);
			expect(updates).toEqual([{ content: [{ type: "text", text: "partial" }], details: {} }]);
			expect(witnesses.filter((witness) => witness.toolCallId === nestedId)).toEqual([
				{ pipeline: "prepared", toolCallId: nestedId },
			]);
		} finally {
			harness.cleanup();
		}
	});
});
