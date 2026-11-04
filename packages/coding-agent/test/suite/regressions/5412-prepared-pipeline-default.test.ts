import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../harness.ts";

// senpi#5412 (S21a): a real AgentSession runs its tool calls on the prepared pipeline unless
// `SENPI_EXECUTION_PIPELINE=legacy` opts out (until S36). An explicit sink sees which pipeline ran; nothing is persisted.
afterEach(() => {
	vi.unstubAllEnvs();
});

it.each([
	["", "prepared"],
	["default", "prepared"],
	["prepared", "prepared"],
	["legacy", "legacy"],
])("SENPI_EXECUTION_PIPELINE=%j runs the %s pipeline", async (flag, pipeline) => {
	vi.stubEnv("SENPI_EXECUTION_PIPELINE", flag);
	const harness = await createHarness({
		persistSession: true,
		initialActiveToolNames: [],
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "witness_probe",
					label: "probe",
					description: "fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				});
			},
		],
	});
	try {
		const witnesses: unknown[] = [];
		harness.agent.onExecutionPipeline = (witness) => {
			witnesses.push(witness);
		};
		await harness.session.bindExtensions({});
		const call = fauxToolCall("witness_probe", {});
		harness.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("run");

		expect(harness.agent.toolHost === undefined).toBe(pipeline === "legacy");
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		expect(witnesses).toEqual([{ pipeline, toolCallId: call.id }]);
		expect(readFileSync(sessionFile, "utf8")).not.toContain('"execution-pipeline"');
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({ toolCallId: call.id, isError: false });
	} finally {
		harness.cleanup();
	}
});
