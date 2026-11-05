import type { ExecutionPipelineWitness } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createExecuteToolHarness } from "../helpers/execute-tool-harness.ts";

describe("pi.executeTool on the session's ToolHost", () => {
	it("runs the tool body on the prepared pipeline and records its witness for that call", async () => {
		const bodyCallIds: string[] = [];
		const harness = await createExecuteToolHarness((pi) => {
			pi.registerTool({
				name: "probe_ext",
				label: "Probe",
				description: "Echoes its value",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (toolCallId, params) => {
					bodyCallIds.push(toolCallId);
					return { content: [{ type: "text", text: params.value }], details: {} };
				},
			});
		});
		const witnesses: ExecutionPipelineWitness[] = [];
		harness.agent.onExecutionPipeline = (witness) => {
			witnesses.push(witness);
		};

		try {
			const result = await harness.api.executeTool("probe_ext", { value: "ran" });

			expect(result.content).toEqual([{ type: "text", text: "ran" }]);
			expect(bodyCallIds).toHaveLength(1);
			expect(witnesses).toEqual([{ pipeline: "prepared", toolCallId: bodyCallIds[0] }]);
		} finally {
			harness.cleanup();
		}
	});
});
